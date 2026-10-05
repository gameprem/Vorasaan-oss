import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ApprovedModel, OrgIntegration, PrismaClient } from '@vorasaan/db';
import {
  type AiModelsView,
  AiProvider,
  type AiProviderView,
  type AiSettingsInput,
  type AiSettingsView,
  AiTask as AiTaskKind,
  type AiTestResult,
  type ApprovedModelSettingsView,
  type CreateAiProviderInput,
  type CreateApprovedModelInput,
  DEFAULT_PROVIDER_NAMES,
  type ModelPrices,
  type OpenRouterModelsView,
  type RecordedModel,
  type SetAiTaskModelsInput,
  type UpdateAiProviderInput,
  type UpdateApprovedModelInput,
} from '@vorasaan/shared';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import {
  AI_TASKS,
  type AiTask,
  envFallbackModel,
  envModelOverride,
  envOverridesFor,
} from './ai.config.ts';
import type { ModelChoice } from './ai.port.ts';
import { envModelContextWindow, prefilledContextWindow } from './context-window.ts';
import { type ResolvedProvider, toMastraModel } from './model-config.ts';
import { listOpenRouterModels, openRouterContextWindow } from './openrouter.ts';

export const AI_CONNECTION_TESTER = Symbol('AI_CONNECTION_TESTER');
export type AiConnectionTester = (provider: ResolvedProvider) => Promise<void>;

const LLM_PROVIDERS: AiProvider[] = AiProvider.options;

/** The Mastra "provider/" prefix of an env model, and the provider kind whose key it may use. */
const ENV_PREFIXES: Partial<Record<string, AiProvider>> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  openrouter: 'OPENROUTER',
};

/** The `baseUrl` of a provider input, whatever its kind. */
function baseUrlOf(input: object): unknown {
  return 'baseUrl' in input ? input.baseUrl : undefined;
}

/** The base URL a provider of this kind stores: only a custom endpoint has one. */
function storedBaseUrl(input: object, kind: AiProvider): string | null {
  const baseUrl = baseUrlOf(input);
  return kind === 'OPENAI_COMPATIBLE' && typeof baseUrl === 'string' ? baseUrl : null;
}

/**
 * OpenRouter's URL is fixed (ticket 0064): a base URL given for it is refused,
 * as for the other fixed providers, never stored or called.
 */
function refuseFixedUrl(input: object, kind: AiProvider): void {
  if (kind === 'OPENROUTER' && baseUrlOf(input) !== undefined) {
    throw new UnprocessableEntityException("OpenRouter's base URL is fixed: leave it out");
  }
}

type ModelWithProvider = ApprovedModel & { integration: OrgIntegration };

/**
 * The Organization's AI providers (LLM `OrgIntegration`s, keys encrypted), its
 * Approved Models and the model of each AI task (ADR 0010), and the choice of
 * model for each AI call.
 */
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

  private async requireOrganizationId(): Promise<string> {
    const id = await this.organizationId();
    if (!id) throw new UnprocessableEntityException('Run setup first');
    return id;
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  async view(): Promise<AiSettingsView> {
    const organizationId = await this.organizationId();
    if (!organizationId) return { providers: [], models: [], tasks: this.taskViews([]) };
    const [providers, models, taskModels] = await Promise.all([
      this.db.orgIntegration.findMany({
        where: { organizationId, provider: { in: LLM_PROVIDERS } },
        include: { _count: { select: { approvedModels: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.models(organizationId),
      this.db.aiTaskModel.findMany({ where: { organizationId } }),
    ]);
    return {
      providers: providers.map((p) => this.providerView(p, p._count.approvedModels)),
      models: models.map(modelSettingsView),
      tasks: this.taskViews(taskModels),
    };
  }

  private taskViews(rows: { task: AiTaskKind; approvedModelId: string }[]) {
    return AiTaskKind.options.map((task) => ({
      task,
      approvedModelId: rows.find((r) => r.task === task)?.approvedModelId ?? null,
      envOverrides: envOverridesFor(task),
    }));
  }

  private providerView(p: OrgIntegration, modelCount: number): AiProviderView {
    const key = this.secrets().decrypt(p.secretEncrypted);
    return {
      id: p.id,
      kind: p.provider as AiProvider,
      name: p.name ?? DEFAULT_PROVIDER_NAMES[p.provider as AiProvider],
      baseUrl: p.baseUrl,
      apiKeyHint: key.length > 4 ? `…${key.slice(-4)}` : '…',
      modelCount,
    };
  }

  private models(organizationId: string): Promise<ModelWithProvider[]> {
    return this.db.approvedModel.findMany({
      where: { organizationId },
      include: { integration: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** What every member may see: names and notes only, never a provider, key or URL. */
  async publicModels(): Promise<AiModelsView> {
    const organizationId = await this.organizationId();
    if (!organizationId) return { models: [], chatDefaultId: null };
    const [models, chat] = await Promise.all([
      this.db.approvedModel.findMany({
        where: { organizationId },
        select: { id: true, displayName: true, note: true, isDefault: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
      this.db.aiTaskModel.findUnique({
        where: { organizationId_task: { organizationId, task: 'CHAT' } },
        select: { approvedModelId: true },
      }),
    ]);
    // What a Conversation with no picked model runs on (chooseModel without a pick).
    const chatDefaultId = envModelOverride('chat')
      ? null
      : (chat?.approvedModelId ?? models.find((m) => m.isDefault)?.id ?? null);
    return { models, chatDefaultId };
  }

  // ─── The chat picker (ticket 0054) ──────────────────────────────────────────

  /** A model picked in the chat: 422 unless it is one of the Organization's Approved Models. */
  async assertPickable(approvedModelId: string): Promise<void> {
    const organizationId = await this.organizationId();
    const found = organizationId
      ? await this.db.approvedModel.count({ where: { id: approvedModelId, organizationId } })
      : 0;
    if (!found) {
      throw new UnprocessableEntityException(
        'That model is not one of the Approved Models. Pick another one.',
      );
    }
  }

  /** Whether the Approved Model still exists. */
  async exists(approvedModelId: string): Promise<boolean> {
    return (await this.db.approvedModel.count({ where: { id: approvedModelId } })) > 0;
  }

  /**
   * What to record for a chosen model: the Approved Model with its display name as
   * it is now, or the env model's "provider/model". Never the key.
   */
  async record(choice: ModelChoice): Promise<RecordedModel> {
    const approved = choice.approvedModelId
      ? await this.db.approvedModel.findUnique({
          where: { id: choice.approvedModelId },
          select: { displayName: true },
        })
      : null;
    return {
      approvedModelId: choice.approvedModelId,
      displayName: approved?.displayName ?? null,
      modelId: choice.name,
    };
  }

  // ─── Providers ────────────────────────────────────────────────────────────

  private async provider(organizationId: string, id: string): Promise<OrgIntegration> {
    const provider = await this.db.orgIntegration.findFirst({
      where: { id, organizationId, provider: { in: LLM_PROVIDERS } },
    });
    if (!provider) throw new NotFoundException('No such AI provider');
    return provider;
  }

  async createProvider(input: CreateAiProviderInput): Promise<AiProviderView> {
    refuseFixedUrl(input, input.kind);
    const organizationId = await this.requireOrganizationId();
    const created = await this.db.orgIntegration.create({
      data: {
        organizationId,
        provider: input.kind,
        name: input.name,
        baseUrl: storedBaseUrl(input, input.kind),
        secretEncrypted: this.secrets().encrypt(input.apiKey),
      },
    });
    return this.providerView(created, 0);
  }

  async updateProvider(id: string, input: UpdateAiProviderInput): Promise<AiProviderView> {
    const organizationId = await this.requireOrganizationId();
    const existing = await this.provider(organizationId, id);
    if (input.baseUrl !== undefined && existing.provider !== 'OPENAI_COMPATIBLE') {
      throw new UnprocessableEntityException('Only a custom endpoint has a base URL');
    }
    const updated = await this.db.orgIntegration.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey ? { secretEncrypted: this.secrets().encrypt(input.apiKey) } : {}),
      },
      include: { _count: { select: { approvedModels: true } } },
    });
    return this.providerView(updated, updated._count.approvedModels);
  }

  /**
   * OpenRouter's model list for the picker (ticket 0064). Only an OpenRouter
   * provider has one; when it can't be loaded, the view says why and the Admin
   * types the model id.
   */
  async providerModels(id: string): Promise<OpenRouterModelsView> {
    const organizationId = await this.requireOrganizationId();
    const provider = await this.provider(organizationId, id);
    if (provider.provider !== 'OPENROUTER') {
      throw new UnprocessableEntityException('Only an OpenRouter provider has a model list');
    }
    return listOpenRouterModels();
  }

  /** The setup wizard's list, before any provider is saved. */
  openRouterModels(): Promise<OpenRouterModelsView> {
    return listOpenRouterModels();
  }

  /**
   * The window a new model gets when the Admin gives none: for OpenRouter, its
   * `context_length` from the list (ticket 0064); else the known model's, else the default.
   */
  private async windowFor(kind: AiProvider, modelId: string): Promise<number> {
    if (kind === 'OPENROUTER') {
      const listed = await openRouterContextWindow(modelId);
      if (listed) return listed;
    }
    return prefilledContextWindow(modelId);
  }

  /** Refused while Approved Models run on it: remove or move them first. */
  async deleteProvider(id: string): Promise<void> {
    const organizationId = await this.requireOrganizationId();
    await this.provider(organizationId, id);
    const inUse = await this.db.approvedModel.count({ where: { integrationId: id } });
    if (inUse > 0) {
      throw new ConflictException(
        'Approved Models run on this provider. Remove them or move them to another provider first.',
      );
    }
    await this.db.orgIntegration.delete({ where: { id } });
  }

  // ─── Approved Models ──────────────────────────────────────────────────────

  private async model(organizationId: string, id: string): Promise<ModelWithProvider> {
    const model = await this.db.approvedModel.findFirst({
      where: { id, organizationId },
      include: { integration: true },
    });
    if (!model) throw new NotFoundException('No such Approved Model');
    return model;
  }

  private async assertNameFree(organizationId: string, displayName: string, exceptId?: string) {
    const taken = await this.db.approvedModel.findFirst({
      where: { organizationId, displayName, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`An Approved Model is already named "${displayName}"`);
  }

  /** The first Approved Model is the default, whatever `isDefault` says. */
  async createModel(input: CreateApprovedModelInput): Promise<ApprovedModelSettingsView> {
    const organizationId = await this.requireOrganizationId();
    const provider = await this.provider(organizationId, input.providerId);
    await this.assertNameFree(organizationId, input.displayName);
    const contextWindow =
      input.contextWindow ?? (await this.windowFor(provider.provider as AiProvider, input.modelId));
    const created = await conflictOnRace(() =>
      this.db.$transaction(async (tx) => {
        const last = await tx.approvedModel.findFirst({
          where: { organizationId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        const isDefault = !last || input.isDefault === true;
        if (isDefault) {
          await tx.approvedModel.updateMany({
            where: { organizationId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.approvedModel.create({
          data: {
            organizationId,
            integrationId: input.providerId,
            modelId: input.modelId,
            displayName: input.displayName,
            note: input.note ?? null,
            contextWindow,
            ...priceColumns(input.prices ?? null),
            position: last ? last.position + 1 : 0,
            isDefault,
          },
          include: { integration: true },
        });
      }),
    );
    return modelSettingsView(created);
  }

  async updateModel(
    id: string,
    input: UpdateApprovedModelInput,
  ): Promise<ApprovedModelSettingsView> {
    const organizationId = await this.requireOrganizationId();
    const existing = await this.model(organizationId, id);
    const provider = input.providerId
      ? await this.provider(organizationId, input.providerId)
      : existing.integration;
    // A new model id without a window given takes the new model's prefilled window.
    const contextWindow =
      input.contextWindow ??
      (input.modelId && input.modelId !== existing.modelId
        ? await this.windowFor(provider.provider as AiProvider, input.modelId)
        : undefined);
    if (input.displayName) await this.assertNameFree(organizationId, input.displayName, id);
    const updated = await conflictOnRace(() =>
      this.db.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.approvedModel.updateMany({
            where: { organizationId, isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
        }
        return tx.approvedModel.update({
          where: { id },
          data: {
            ...(input.providerId ? { integrationId: input.providerId } : {}),
            ...(input.modelId ? { modelId: input.modelId } : {}),
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(input.prices !== undefined ? priceColumns(input.prices) : {}),
            ...(input.isDefault ? { isDefault: true } : {}),
          },
          include: { integration: true },
        });
      }),
    );
    return modelSettingsView(updated);
  }

  /**
   * The default can't be removed: make another model the default first. Tasks
   * set to a removed model fall back to the default (their rows cascade).
   */
  async deleteModel(id: string): Promise<void> {
    const organizationId = await this.requireOrganizationId();
    const model = await this.model(organizationId, id);
    if (model.isDefault) {
      throw new ConflictException(
        'This is the default model. Make another model the default before removing it.',
      );
    }
    await this.db.approvedModel.delete({ where: { id } });
  }

  /** Tests one Approved Model with a tiny real call, the way setup tests a provider. */
  async testModel(id: string): Promise<AiTestResult> {
    const organizationId = await this.requireOrganizationId();
    return this.check(this.resolve(await this.model(organizationId, id)));
  }

  // ─── Model per task ───────────────────────────────────────────────────────

  async setTaskModels(input: SetAiTaskModelsInput): Promise<AiSettingsView> {
    const organizationId = await this.requireOrganizationId();
    const entries = Object.entries(input.tasks) as [AiTaskKind, string | null][];
    const ids = [...new Set(entries.flatMap(([, id]) => (id ? [id] : [])))];
    const found = await this.db.approvedModel.count({ where: { organizationId, id: { in: ids } } });
    if (found !== ids.length) throw new UnprocessableEntityException('Pick an Approved Model');
    await this.db.$transaction(
      entries.map(([task, approvedModelId]) =>
        approvedModelId
          ? this.db.aiTaskModel.upsert({
              where: { organizationId_task: { organizationId, task } },
              update: { approvedModelId },
              create: { organizationId, task, approvedModelId },
            })
          : this.db.aiTaskModel.deleteMany({ where: { organizationId, task } }),
      ),
    );
    return this.view();
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  /** What setup refuses before it writes anything (a base URL for OpenRouter). */
  assertSetupInput(input: AiSettingsInput): void {
    refuseFixedUrl(input, input.provider);
  }

  /** First boot: the wizard's provider becomes the first provider, its model the default. */
  async setupFirst(input: AiSettingsInput, organizationId: string): Promise<void> {
    refuseFixedUrl(input, input.provider);
    if (!input.apiKey) throw new UnprocessableEntityException('Enter an API key or token');
    const secretEncrypted = this.secrets().encrypt(input.apiKey);
    const contextWindow = await this.windowFor(input.provider, input.model);
    await this.db.$transaction(async (tx) => {
      const provider = await tx.orgIntegration.create({
        data: {
          organizationId,
          provider: input.provider,
          name: DEFAULT_PROVIDER_NAMES[input.provider],
          baseUrl: storedBaseUrl(input, input.provider),
          secretEncrypted,
        },
      });
      await tx.approvedModel.create({
        data: {
          organizationId,
          integrationId: provider.id,
          modelId: input.model,
          displayName: input.model,
          contextWindow,
          position: 0,
          isDefault: true,
        },
      });
    });
  }

  /** Checks a provider and model before setup saves them (the key is required). */
  async test(input: AiSettingsInput): Promise<AiTestResult> {
    refuseFixedUrl(input, input.provider);
    if (!input.apiKey) return { ok: false, message: 'Enter an API key', latencyMs: null };
    return this.check({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: storedBaseUrl(input, input.provider),
    });
  }

  private async check(provider: ResolvedProvider): Promise<AiTestResult> {
    try {
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
      return { ok: false, message: describeProviderError(error, provider.apiKey), latencyMs: null };
    }
  }

  // ─── Choosing the model of a call ─────────────────────────────────────────

  private resolve(model: ModelWithProvider): ResolvedProvider {
    return {
      provider: model.integration.provider as AiProvider,
      model: model.modelId,
      apiKey: this.secrets().decrypt(model.integration.secretEncrypted),
      baseUrl: model.integration.baseUrl,
    };
  }

  private approved(model: ModelWithProvider): ModelChoice {
    return {
      source: 'APPROVED_MODEL',
      approvedModelId: model.id,
      integrationId: model.integrationId,
      provider: this.resolve(model),
      name: model.modelId,
      contextWindow: model.contextWindow,
    };
  }

  /**
   * The model of one AI call, in order:
   * 1. `approvedModelId`, when the caller picked one that still exists;
   * 2. the task's `VORASAAN_MODEL_<TASK>` env var, when set;
   * 3. the Approved Model set for the task in Settings;
   * 4. the default Approved Model;
   * 5. with no Approved Model at all, `VORASAAN_MODEL` (or the built-in default).
   * An env model ("anthropic/…", "openai/…") uses the key of a connected provider
   * of that kind when there is one, else the provider's env key, as before.
   */
  async chooseModel(task: AiTask, approvedModelId?: string): Promise<ModelChoice> {
    const organizationId = await this.organizationId();
    const find = (where: { id: string } | { isDefault: true }) =>
      organizationId
        ? this.db.approvedModel.findFirst({
            where: { organizationId, ...where },
            include: { integration: true },
          })
        : Promise.resolve(null);

    if (approvedModelId) {
      const picked = await find({ id: approvedModelId });
      if (picked) return this.approved(picked);
    }
    const override = envModelOverride(task);
    if (override) return this.fromEnv(organizationId, override);
    if (organizationId) {
      const mapped = await this.db.aiTaskModel.findUnique({
        where: { organizationId_task: { organizationId, task: AI_TASKS[task].kind } },
        include: { approvedModel: { include: { integration: true } } },
      });
      if (mapped) return this.approved(mapped.approvedModel);
    }
    const fallback = await find({ isDefault: true });
    if (fallback) return this.approved(fallback);
    return this.fromEnv(organizationId, envFallbackModel());
  }

  private async fromEnv(organizationId: string | undefined, name: string): Promise<ModelChoice> {
    const [prefix, ...rest] = name.split('/');
    const kind = prefix ? ENV_PREFIXES[prefix] : undefined;
    const integration =
      kind && rest.length && organizationId
        ? await this.db.orgIntegration.findFirst({
            where: { organizationId, provider: kind },
            orderBy: { createdAt: 'asc' },
          })
        : null;
    const contextWindow = envModelContextWindow(name);
    if (!kind || !integration) {
      return {
        source: 'ENV',
        approvedModelId: null,
        integrationId: null,
        provider: null,
        name,
        contextWindow,
      };
    }
    return {
      source: 'ENV',
      approvedModelId: null,
      integrationId: integration.id,
      provider: {
        provider: kind,
        model: rest.join('/'),
        apiKey: this.secrets().decrypt(integration.secretEncrypted),
        baseUrl: null,
      },
      name,
      contextWindow,
    };
  }
}

function modelSettingsView(m: ModelWithProvider): ApprovedModelSettingsView {
  const kind = m.integration.provider as AiProvider;
  return {
    id: m.id,
    providerId: m.integrationId,
    providerName: m.integration.name ?? DEFAULT_PROVIDER_NAMES[kind],
    providerKind: kind,
    modelId: m.modelId,
    displayName: m.displayName,
    note: m.note,
    contextWindow: m.contextWindow,
    prices:
      m.inputPricePerMillion === null || m.outputPricePerMillion === null
        ? null
        : { inputPerMillion: m.inputPricePerMillion, outputPerMillion: m.outputPricePerMillion },
    position: m.position,
    isDefault: m.isDefault,
  };
}

/** An Approved Model's price columns (ticket 0075): both set, or both null. */
function priceColumns(prices: ModelPrices | null) {
  return {
    inputPricePerMillion: prices?.inputPerMillion ?? null,
    outputPricePerMillion: prices?.outputPerMillion ?? null,
  };
}

/** Two Admins saving at once can hit a unique index (name, or the one default): a 409. */
async function conflictOnRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new ConflictException(
        'Someone changed the Approved Models at the same time. Try again.',
      );
    }
    throw error;
  }
}

/**
 * Surfaces the provider's own message (bad key, unknown model, unreachable URL),
 * with the key masked in case the provider echoes it.
 */
function describeProviderError(error: unknown, apiKey: string): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const next = (current as Error & { cause?: unknown }).cause;
    if (!(next instanceof Error)) break;
    current = next;
  }
  let message = current instanceof Error ? current.message : String(error);
  if (apiKey.length >= 8) message = message.replaceAll(apiKey, '…');
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
