import { z } from 'zod';

/**
 * `PUT /settings/embeddings` (Admins): any OpenAI-compatible embeddings endpoint
 * (ADR 0007). `apiKey` may be omitted when updating: the stored key is kept,
 * unless the base URL moves to another host.
 */
export const EmbeddingSettingsInput = z.object({
  baseUrl: z.url({
    protocol: /^https?$/,
    message: 'Enter the full base URL, e.g. https://api.openai.com/v1',
  }),
  model: z.string().trim().min(1, 'Enter a model name').max(200),
  apiKey: z.string().trim().min(1, 'Enter an API key').optional(),
});
export type EmbeddingSettingsInput = z.infer<typeof EmbeddingSettingsInput>;

/** The API key is never returned, only whether one is stored. */
export const EmbeddingSettingsView = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  apiKeySet: z.boolean(),
});
export type EmbeddingSettingsView = z.infer<typeof EmbeddingSettingsView>;

/** `POST /settings/embeddings/test`: embeds a short text without saving anything. */
export const EmbeddingTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** The model's vector size, when the call worked. */
  dimensions: z.number().int().nullable(),
});
export type EmbeddingTestResult = z.infer<typeof EmbeddingTestResult>;

/**
 * `POST /settings/embeddings/reindex`: `stale` re-indexes what is missing, has no
 * embedding, or was embedded by another model; `all` re-indexes everything.
 */
export const ReindexInput = z.object({ scope: z.enum(['stale', 'all']).default('stale') });
export type ReindexInput = z.infer<typeof ReindexInput>;

export const ReindexResult = z.object({ queued: z.number().int() });
export type ReindexResult = z.infer<typeof ReindexResult>;
