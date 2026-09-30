import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { AiProvider, AiSettingsInput, AiSettingsView, AiTestResult } from '@vorasaan/shared';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { type ResolvedProvider, toMastraModel } from './model-config.ts';

export const AI_CONNECTION_TESTER = Symbol('AI_CONNECTION_TESTER');
export type AiConnectionTester = (provider: ResolvedProvider) => Promise<void>;

const LLM_PROVIDERS: AiProvider[] = ['ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE'];

/** The Organization's LLM provider, stored in OrgIntegration with the key encrypted. */
@Injectable()
export class AiSettingsService {
  private box: SecretBox | undefined;

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_CONNECTION_TESTER) private readonly tester: AiConnectionTester,
  ) {}

  /** Lazily, so the server still boots (and says why) without VORASAAN_SECRET_KEY. */
  private secrets(): SecretBox {
    this.box ??= SecretBox.fromEnv();
    return this.box;
  }

  // Self-hosted: one Organization per instance.
  private async organizationId(): Promise<string | undefined> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return org?.id;
  }

  private async defaultIntegration() {
    const organizationId = await this.organizationId();
    if (!organizationId) return null;
    return this.db.orgIntegration.findFirst({
      where: { organizationId, isDefaultLlm: true, provider: { in: LLM_PROVIDERS } },
    });
  }

  async view(): Promise<AiSettingsView> {
    const integration = await this.defaultIntegration();
    if (!integration) {
      return { configured: false, provider: null, model: null, baseUrl: null, apiKeyHint: null };
    }
    const key = this.secrets().decrypt(integration.secretEncrypted);
    return {
      configured: true,
      provider: integration.provider as AiProvider,
      model: integration.model,
      baseUrl: integration.baseUrl,
      apiKeyHint: key.length > 4 ? `…${key.slice(-4)}` : '…',
    };
  }

  /** The decrypted default provider, or null when none is set (dev falls back to env). */
  async resolved(): Promise<ResolvedProvider | null> {
    const integration = await this.defaultIntegration();
    if (!integration?.model) return null;
    return {
      provider: integration.provider as AiProvider,
      model: integration.model,
      apiKey: this.secrets().decrypt(integration.secretEncrypted),
      baseUrl: integration.baseUrl,
    };
  }

  /** Fills in the stored key when the input leaves it out (editing without re-typing it). */
  private async complete(input: AiSettingsInput): Promise<ResolvedProvider> {
    let apiKey = input.apiKey;
    if (!apiKey) {
      const organizationId = await this.organizationId();
      const existing = organizationId
        ? await this.db.orgIntegration.findUnique({
            where: { organizationId_provider: { organizationId, provider: input.provider } },
          })
        : null;
      if (!existing) throw new UnprocessableEntityException('Enter an API key for this provider');
      apiKey = this.secrets().decrypt(existing.secretEncrypted);
    }
    return {
      provider: input.provider,
      model: input.model,
      apiKey,
      baseUrl: input.provider === 'OPENAI_COMPATIBLE' ? input.baseUrl : null,
    };
  }

  async save(input: AiSettingsInput, organizationId?: string): Promise<AiSettingsView> {
    const orgId = organizationId ?? (await this.organizationId());
    if (!orgId) throw new UnprocessableEntityException('Run setup first');
    const provider = await this.complete(input);
    const secretEncrypted = this.secrets().encrypt(provider.apiKey);

    await this.db.$transaction([
      this.db.orgIntegration.updateMany({
        where: { organizationId: orgId, provider: { in: LLM_PROVIDERS } },
        data: { isDefaultLlm: false },
      }),
      this.db.orgIntegration.upsert({
        where: { organizationId_provider: { organizationId: orgId, provider: input.provider } },
        update: {
          model: provider.model,
          baseUrl: provider.baseUrl,
          secretEncrypted,
          isDefaultLlm: true,
        },
        create: {
          organizationId: orgId,
          provider: input.provider,
          model: provider.model,
          baseUrl: provider.baseUrl,
          secretEncrypted,
          isDefaultLlm: true,
        },
      }),
    ]);
    return this.view();
  }

  async test(input: AiSettingsInput): Promise<AiTestResult> {
    let provider: ResolvedProvider;
    try {
      provider = await this.complete(input);
      toMastraModel(provider);
    } catch (error) {
      return { ok: false, message: (error as Error).message, latencyMs: null };
    }
    const started = performance.now();
    try {
      await this.tester(provider);
      const latencyMs = Math.round(performance.now() - started);
      return { ok: true, message: `Connected to ${provider.model}`, latencyMs };
    } catch (error) {
      return { ok: false, message: describeProviderError(error), latencyMs: null };
    }
  }
}

/** Surfaces the provider's own message (bad key, unknown model, unreachable URL). */
function describeProviderError(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const next = (current as Error & { cause?: unknown }).cause;
    if (!(next instanceof Error)) break;
    current = next;
  }
  const message = current instanceof Error ? current.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
