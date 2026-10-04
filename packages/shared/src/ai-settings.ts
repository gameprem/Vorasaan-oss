import { z } from 'zod';

/** The kinds of LLM provider an Admin can connect. */
export const AiProvider = z.enum(['ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE', 'OPENROUTER']);
export type AiProvider = z.infer<typeof AiProvider>;

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  ANTHROPIC: 'claude-opus-5-5',
  OPENAI: 'gpt-5.6-sol',
  OPENAI_COMPATIBLE: '',
  // Picked from OpenRouter's model list (ticket 0064).
  OPENROUTER: '',
};

/** The name a provider gets when none is given (setup, and the migrated provider). */
export const DEFAULT_PROVIDER_NAMES: Record<AiProvider, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
  OPENAI_COMPATIBLE: 'Custom endpoint',
  OPENROUTER: 'OpenRouter',
};

/**
 * A model's context window (ticket 0060, ADR 0012): how many tokens one call may
 * hold, prompt and reply together. Below the minimum a turn can't fit at all.
 */
export const CONTEXT_WINDOW_LIMITS = { min: 4_096, max: 10_000_000 } as const;

/**
 * Context windows of known model ids, by prefix; the first match wins. A new
 * Approved Model is prefilled from it (the server keeps its backfill migration in
 * sync); an unknown model gets the server's default.
 */
export const KNOWN_CONTEXT_WINDOWS: readonly (readonly [RegExp, number])[] = [
  [/^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/, 1_000_000],
  [/^claude-/, 200_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-5/, 400_000],
  [/^(gpt-4o|gpt-4-turbo)/, 128_000],
  [/^o[134](-|$)/, 200_000],
  [/^gpt-3\.5-turbo/, 16_385],
  [/^gpt-4(-|$)/, 8_192],
];

/** The context window of a known model id (a "provider/" prefix is allowed), or null. */
export function knownContextWindow(modelId: string): number | null {
  const id = modelId
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, '');
  return KNOWN_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

export const ContextWindow = z
  .int('Enter a whole number of tokens')
  .min(
    CONTEXT_WINDOW_LIMITS.min,
    `At least ${CONTEXT_WINDOW_LIMITS.min.toLocaleString('en')} tokens`,
  )
  .max(
    CONTEXT_WINDOW_LIMITS.max,
    `At most ${CONTEXT_WINDOW_LIMITS.max.toLocaleString('en')} tokens`,
  );

const Model = z.string().trim().min(1, 'Enter a model name').max(200);
const ApiKey = z.string().trim().min(1, 'Enter an API key').max(4_000);
const BaseUrl = z.url({ message: 'Enter the full URL, e.g. http://localhost:20128/v1' });
const ProviderName = z.string().trim().min(1, 'Name the provider').max(100);
const Id = z.uuid();
/**
 * OpenRouter's base URL is fixed (ticket 0064). The field is accepted only so the
 * server can refuse it with a 422, as it refuses a base URL on the other fixed providers.
 */
const FixedUrl = z.unknown().optional();

/**
 * One provider and its model, as the setup wizard asks for them: it becomes the
 * first provider and the default Approved Model. `apiKey` is required at setup.
 * A custom endpoint needs its base URL, e.g. http://localhost:20128/v1 for 9Router.
 */
export const AiSettingsInput = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ANTHROPIC'), model: Model, apiKey: ApiKey.optional() }),
  z.object({ provider: z.literal('OPENAI'), model: Model, apiKey: ApiKey.optional() }),
  z.object({
    provider: z.literal('OPENAI_COMPATIBLE'),
    model: Model,
    baseUrl: BaseUrl,
    apiKey: ApiKey.optional(),
  }),
  z.object({
    provider: z.literal('OPENROUTER'),
    model: Model,
    apiKey: ApiKey.optional(),
    baseUrl: FixedUrl,
  }),
]);
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

export const AiTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResult>;

// ─── Providers (Admin) ──────────────────────────────────────────────────────

/** Connects a provider. Several of the same kind are allowed (e.g. two endpoints). */
export const CreateAiProviderInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ANTHROPIC'), name: ProviderName, apiKey: ApiKey }),
  z.object({ kind: z.literal('OPENAI'), name: ProviderName, apiKey: ApiKey }),
  z.object({
    kind: z.literal('OPENAI_COMPATIBLE'),
    name: ProviderName,
    baseUrl: BaseUrl,
    apiKey: ApiKey,
  }),
  /** A key only: the base URL is OpenRouter's own (https://openrouter.ai/api/v1). */
  z.object({
    kind: z.literal('OPENROUTER'),
    name: ProviderName,
    apiKey: ApiKey,
    baseUrl: FixedUrl,
  }),
]);
export type CreateAiProviderInput = z.infer<typeof CreateAiProviderInput>;

/** The kind can't change. A left-out key keeps the stored one; `baseUrl` is for custom endpoints. */
export const UpdateAiProviderInput = z.object({
  name: ProviderName.optional(),
  baseUrl: BaseUrl.optional(),
  apiKey: ApiKey.optional(),
});
export type UpdateAiProviderInput = z.infer<typeof UpdateAiProviderInput>;

export const AiProviderView = z.object({
  id: z.string(),
  kind: AiProvider,
  name: z.string(),
  baseUrl: z.string().nullable(),
  /** Only the last four characters of the stored key, for recognition. */
  apiKeyHint: z.string(),
  /** How many Approved Models run on it; a provider with models can't be removed. */
  modelCount: z.number().int(),
});
export type AiProviderView = z.infer<typeof AiProviderView>;

/**
 * One model of OpenRouter's list (`GET /models`), for the picker (ticket 0064).
 * `contextWindow` is its `context_length`, or null when it is missing or out of range.
 */
export const OpenRouterModelView = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().nullable(),
});
export type OpenRouterModelView = z.infer<typeof OpenRouterModelView>;

/**
 * OpenRouter's model list. When it can't be loaded, `models` is empty and `error`
 * says why: the Admin types the model id instead.
 */
export const OpenRouterModelsView = z.object({
  models: z.array(OpenRouterModelView),
  error: z.string().nullable(),
});
export type OpenRouterModelsView = z.infer<typeof OpenRouterModelsView>;

// ─── Approved Models (Admin) ────────────────────────────────────────────────

const DisplayName = z.string().trim().min(1, 'Name the model, e.g. "Fast"').max(60);
const Note = z.string().trim().max(300).nullable();

/** The first Approved Model is the default; later ones only when `isDefault` is set. */
export const CreateApprovedModelInput = z.object({
  providerId: Id,
  modelId: Model,
  displayName: DisplayName,
  note: Note.optional(),
  /** Tokens; left out, it is prefilled for a known model, else the server's default. */
  contextWindow: ContextWindow.optional(),
  isDefault: z.boolean().optional(),
});
export type CreateApprovedModelInput = z.infer<typeof CreateApprovedModelInput>;

/**
 * `isDefault: true` makes it the default. The default can't be unset directly:
 * make another model the default instead.
 */
export const UpdateApprovedModelInput = z.object({
  providerId: Id.optional(),
  modelId: Model.optional(),
  displayName: DisplayName.optional(),
  note: Note.optional(),
  contextWindow: ContextWindow.optional(),
  isDefault: z.literal(true).optional(),
});
export type UpdateApprovedModelInput = z.infer<typeof UpdateApprovedModelInput>;

export const ApprovedModelSettingsView = z.object({
  id: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerKind: AiProvider,
  modelId: z.string(),
  displayName: z.string(),
  note: z.string().nullable(),
  /** Tokens one call may hold, prompt and reply together: every AI task's budget is a share of it. */
  contextWindow: z.number().int(),
  position: z.number().int(),
  isDefault: z.boolean(),
});
export type ApprovedModelSettingsView = z.infer<typeof ApprovedModelSettingsView>;

// ─── Model per AI task (Admin) ──────────────────────────────────────────────

/** The AI tasks an Admin sets a model for. Without one, a task uses the default. */
export const AiTask = z.enum([
  'CHOICES',
  'SPEC_PROPOSAL',
  'SUMMARIES',
  'GRILLING',
  'FEATURE_SUGGESTIONS',
  'FIT_CHECK',
  'CHAT',
  'PROMPT_PROPOSALS',
]);
export type AiTask = z.infer<typeof AiTask>;

/** The Approved Model for each task given; `null` (or leaving a task out) means the default. */
export const SetAiTaskModelsInput = z.object({
  tasks: z.partialRecord(AiTask, Id.nullable()),
});
export type SetAiTaskModelsInput = z.infer<typeof SetAiTaskModelsInput>;

export const AiTaskModelView = z.object({
  task: AiTask,
  /** Null: the default Approved Model. */
  approvedModelId: z.string().nullable(),
  /** The VORASAAN_MODEL_* variables set on the server for this task; they win over Settings. */
  envOverrides: z.array(z.string()),
});
export type AiTaskModelView = z.infer<typeof AiTaskModelView>;

/** Settings → AI models. Never includes a key. */
export const AiSettingsView = z.object({
  providers: z.array(AiProviderView),
  models: z.array(ApprovedModelSettingsView),
  tasks: z.array(AiTaskModelView),
});
export type AiSettingsView = z.infer<typeof AiSettingsView>;

// ─── For every member ───────────────────────────────────────────────────────

/** An Approved Model as anyone in the Organization sees it: no provider, key or URL. */
export const AiModelView = z.object({
  id: z.string(),
  displayName: z.string(),
  note: z.string().nullable(),
  isDefault: z.boolean(),
});
export type AiModelView = z.infer<typeof AiModelView>;

export const AiModelsView = z.object({
  models: z.array(AiModelView),
  /**
   * The Approved Model a Conversation runs on until someone picks one in it (ticket
   * 0054): the one set for chat in Settings, else the default. Null when there is no
   * Approved Model, or when the server's VORASAAN_MODEL_CHAT overrides it.
   */
  chatDefaultId: z.string().nullable(),
});
export type AiModelsView = z.infer<typeof AiModelsView>;

/**
 * The model that wrote something, as it was then (ticket 0054): an AI reply in a
 * Conversation, or a proposal drafted there. The name is a snapshot, so it still
 * shows after the Approved Model is renamed or removed.
 */
export const RecordedModel = z.object({
  /** The Approved Model; null when a `VORASAAN_MODEL_*` env var chose the model. */
  approvedModelId: z.string().nullable(),
  /** The Approved Model's display name then, e.g. "Fast"; null for an env model. */
  displayName: z.string().nullable(),
  /** The provider's model id then, or the env var's "provider/model". */
  modelId: z.string(),
});
export type RecordedModel = z.infer<typeof RecordedModel>;
