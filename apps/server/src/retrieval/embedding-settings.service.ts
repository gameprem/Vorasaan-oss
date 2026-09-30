import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type {
  EmbeddingSettingsInput,
  EmbeddingSettingsView,
  EmbeddingTestResult,
} from '@vorasaan/shared';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import {
  EMBEDDING_PORT_FACTORY,
  type EmbeddingConfig,
  EmbeddingError,
  type EmbeddingPort,
  type EmbeddingPortFactory,
} from './embedding.port.ts';

const TEST_TEXT = 'Vorasaan embeddings connection test';

/**
 * The Organization's embeddings endpoint, stored as the EMBEDDINGS OrgIntegration
 * with the API key encrypted. The key never leaves this service except inside
 * the EmbeddingPort it builds, which sends it only to the configured base URL.
 */
@Injectable()
export class EmbeddingSettingsService {
  private box: SecretBox | undefined;

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(EMBEDDING_PORT_FACTORY) private readonly factory: EmbeddingPortFactory,
  ) {}

  /** Lazily, so the server still boots (and says why) without VORASAAN_SECRET_KEY. */
  private secrets(): SecretBox {
    this.box ??= SecretBox.fromEnv();
    return this.box;
  }

  // Self-hosted: one Organization per instance.
  async organizationId(): Promise<string | undefined> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return org?.id;
  }

  private async integration(organizationId?: string) {
    const orgId = organizationId ?? (await this.organizationId());
    if (!orgId) return null;
    return this.db.orgIntegration.findUnique({
      where: { organizationId_provider: { organizationId: orgId, provider: 'EMBEDDINGS' } },
    });
  }

  async view(): Promise<EmbeddingSettingsView> {
    const integration = await this.integration();
    return {
      configured: Boolean(integration?.baseUrl && integration.model),
      baseUrl: integration?.baseUrl ?? null,
      model: integration?.model ?? null,
      apiKeySet: Boolean(integration?.secretEncrypted),
    };
  }

  /** The model chunks should be embedded with, or null when no provider is set. */
  async model(organizationId: string): Promise<string | null> {
    const integration = await this.integration(organizationId);
    return integration?.baseUrl ? (integration.model ?? null) : null;
  }

  /** The Organization's EmbeddingPort, or null when no provider is set. */
  async port(organizationId: string): Promise<EmbeddingPort | null> {
    const integration = await this.integration(organizationId);
    if (!integration?.baseUrl || !integration.model) return null;
    return this.factory({
      baseUrl: integration.baseUrl,
      model: integration.model,
      apiKey: this.secrets().decrypt(integration.secretEncrypted),
    });
  }

  /**
   * Fills in the stored key when the input leaves it out. A stored key is only
   * reused for the same origin, so it can never be sent to a new host.
   */
  private async complete(input: EmbeddingSettingsInput): Promise<EmbeddingConfig> {
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    let apiKey = input.apiKey;
    if (!apiKey) {
      const existing = await this.integration();
      const sameOrigin =
        existing?.baseUrl && new URL(existing.baseUrl).origin === new URL(baseUrl).origin
          ? existing
          : null;
      if (!sameOrigin) {
        throw new EmbeddingError(
          existing ? 'Enter the API key again for the new URL' : 'Enter an API key',
        );
      }
      apiKey = this.secrets().decrypt(sameOrigin.secretEncrypted);
    }
    return { baseUrl, model: input.model, apiKey };
  }

  async save(input: EmbeddingSettingsInput): Promise<EmbeddingSettingsView> {
    const organizationId = await this.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    let config: EmbeddingConfig;
    try {
      config = await this.complete(input);
    } catch (error) {
      if (error instanceof EmbeddingError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    const data = {
      baseUrl: config.baseUrl,
      model: config.model,
      secretEncrypted: this.secrets().encrypt(config.apiKey),
    };
    await this.db.orgIntegration.upsert({
      where: { organizationId_provider: { organizationId, provider: 'EMBEDDINGS' } },
      update: data,
      create: { organizationId, provider: 'EMBEDDINGS', ...data },
    });
    return this.view();
  }

  /** Embeds one short text with the given settings, without saving them. */
  async test(input: EmbeddingSettingsInput): Promise<EmbeddingTestResult> {
    try {
      const port = this.factory(await this.complete(input));
      const [vector] = await port.embed([TEST_TEXT]);
      const dimensions = vector?.length ?? 0;
      return {
        ok: true,
        message: `Connected to ${port.model}: ${dimensions} dimensions`,
        dimensions,
      };
    } catch (error) {
      if (error instanceof EmbeddingError) {
        return { ok: false, message: error.message, dimensions: null };
      }
      throw error;
    }
  }
}
