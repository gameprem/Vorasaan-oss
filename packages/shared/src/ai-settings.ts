import { z } from 'zod';

/** The LLM providers an Admin can pick. */
export const AiProvider = z.enum(['ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE']);
export type AiProvider = z.infer<typeof AiProvider>;

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  ANTHROPIC: 'claude-opus-5-5',
  OPENAI: 'gpt-5.6-sol',
  OPENAI_COMPATIBLE: '',
};

const Model = z.string().trim().min(1, 'Enter a model name');
const ApiKey = z.string().trim().min(1, 'Enter an API key');

/**
 * `apiKey` may be omitted when updating: the stored key is kept.
 * A custom endpoint needs its base URL, e.g. http://localhost:20128/v1 for 9Router.
 */
export const AiSettingsInput = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ANTHROPIC'), model: Model, apiKey: ApiKey.optional() }),
  z.object({ provider: z.literal('OPENAI'), model: Model, apiKey: ApiKey.optional() }),
  z.object({
    provider: z.literal('OPENAI_COMPATIBLE'),
    model: Model,
    baseUrl: z.url({ message: 'Enter the full URL, e.g. http://localhost:20128/v1' }),
    apiKey: ApiKey.optional(),
  }),
]);
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

export const AiSettingsView = z.object({
  configured: z.boolean(),
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  /** Only the last four characters of the stored key, for recognition. */
  apiKeyHint: z.string().nullable(),
});
export type AiSettingsView = z.infer<typeof AiSettingsView>;

export const AiTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResult>;
