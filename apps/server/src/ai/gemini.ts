import { CONTEXT_WINDOW_LIMITS, type ProviderModelsView } from '@vorasaan/shared';
import { z } from 'zod';

// Gemini as an AI provider (ticket 0080). An Admin gives only a key from Google AI
// Studio; the base URL is the Gemini API's own. Calls go through Mastra's bundled
// Google provider (`google/<model id>`, the AI SDK's `@ai-sdk/google`), which speaks
// the Gemini API (`generateContent`) and sends the key in the `x-goog-api-key` header.

/** The Gemini API. */
export const GEMINI_DEFAULT_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The base URL calls and the model list use: the Gemini API's, unless the operator
 * set `GOOGLE_BASE_URL` (tests point it at a stand-in; Mastra's Google provider reads
 * the same variable, so the calls and the list can't disagree). Never from an
 * Admin's input.
 */
export function geminiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.GOOGLE_BASE_URL?.trim();
  if (!raw) return GEMINI_DEFAULT_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return GEMINI_DEFAULT_URL;
    return url.href.replace(/\/+$/, '');
  } catch {
    return GEMINI_DEFAULT_URL;
  }
}

const ModelPage = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1).max(300),
        displayName: z.string().max(300).nullish(),
        inputTokenLimit: z.number().nullish(),
        supportedGenerationMethods: z.array(z.string()).nullish(),
      }),
    )
    .nullish(),
  nextPageToken: z.string().max(1_000).nullish(),
});

/** A window within the limits Settings accepts, else null (the Admin sets it). */
function windowOf(inputTokenLimit: number | null | undefined): number | null {
  if (typeof inputTokenLimit !== 'number' || !Number.isInteger(inputTokenLimit)) return null;
  if (inputTokenLimit < CONTEXT_WINDOW_LIMITS.min || inputTokenLimit > CONTEXT_WINDOW_LIMITS.max) {
    return null;
  }
  return inputTokenLimit;
}

/** How long the model list may take before the picker falls back to typing the id. */
export const GEMINI_LIST_TIMEOUT_MS = 10_000;

/** Pages of the list read at most: a thousand models each, far more than Gemini lists. */
const MAX_PAGES = 5;

/** What a failed list says, without the provider's body (which may echo the key). */
function statusMessage(status: number): string {
  if (status === 400 || status === 401 || status === 403) {
    return `The Gemini API refused the key (${status}) when listing its models`;
  }
  return `The Gemini API answered ${status} for its model list`;
}

/**
 * The Gemini API's model list (`GET /models`), only the models that generate text
 * (`generateContent`), sorted by name. The list needs the key, sent in the
 * `x-goog-api-key` header (never in the URL, so it can't reach a log line). Never
 * throws: a failure is the `error` of the view.
 */
export async function listGeminiModels(
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderModelsView> {
  const base = geminiBaseUrl(env);
  try {
    const listed: z.infer<typeof ModelPage>['models'] = [];
    let pageToken: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${base}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'x-goog-api-key': apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(GEMINI_LIST_TIMEOUT_MS),
      });
      if (!res.ok) return { models: [], error: statusMessage(res.status) };
      const parsed = ModelPage.safeParse(await res.json());
      if (!parsed.success) {
        return { models: [], error: 'The Gemini API sent a model list Vorasaan could not read' };
      }
      listed.push(...(parsed.data.models ?? []));
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) break;
    }
    const models = listed
      .filter(
        (m) =>
          !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'),
      )
      .map((m) => {
        const id = m.name.replace(/^models\//, '');
        return {
          id,
          name: m.displayName?.trim() || id,
          contextWindow: windowOf(m.inputTokenLimit),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
    return { models, error: null };
  } catch (error) {
    const reason =
      (error as Error)?.name === 'TimeoutError'
        ? 'it took too long'
        : ((error as Error)?.message ?? 'unknown error');
    const masked = apiKey.length >= 8 ? reason.replaceAll(apiKey, '…') : reason;
    return { models: [], error: `Could not load the Gemini API's model list: ${masked}` };
  }
}

/** The window (input token limit) the Gemini API lists for a model id, or null. */
export async function geminiContextWindow(
  modelId: string,
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<number | null> {
  const { models } = await listGeminiModels(apiKey, env);
  const id = modelId.trim().replace(/^models\//, '');
  return models.find((m) => m.id === id)?.contextWindow ?? null;
}
