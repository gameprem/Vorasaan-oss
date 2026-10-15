import { CONTEXT_WINDOW_LIMITS, type ProviderModelsView } from '@vorasaan/shared';
import { z } from 'zod';

// OpenRouter as an AI provider (ticket 0064). An Admin gives only a key; the base
// URL is OpenRouter's own. Calls go through Mastra's bundled OpenRouter provider
// (`openrouter/<model id>`), which speaks OpenRouter's OpenAI-compatible API and
// carries cache_control in content parts, system messages included.

/** OpenRouter's API. */
export const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';

/**
 * The base URL calls and the model list use: OpenRouter's, unless the operator set
 * `OPENROUTER_BASE_URL` (tests point it at a stand-in; Mastra's OpenRouter provider
 * reads the same variable). Never from an Admin's input.
 */
export function openRouterBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.OPENROUTER_BASE_URL?.trim();
  if (!raw) return OPENROUTER_DEFAULT_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return OPENROUTER_DEFAULT_URL;
    return url.href.replace(/\/+$/, '');
  } catch {
    return OPENROUTER_DEFAULT_URL;
  }
}

/** The app name OpenRouter shows for calls from Vorasaan. */
export const OPENROUTER_TITLE = 'Vorasaan';

/**
 * The headers OpenRouter asks every call to carry: the install's public URL
 * (`VORASAAN_WEB_URL`, its origin only) and the app name. A value that isn't an
 * http(s) URL falls back to the default, so nothing odd reaches a header.
 */
export function openRouterHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return { 'HTTP-Referer': publicOrigin(env), 'X-Title': OPENROUTER_TITLE };
}

function publicOrigin(env: Record<string, string | undefined>): string {
  const fallback = 'http://localhost:3000';
  const raw = env.VORASAAN_WEB_URL?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

/** Whether a model id on OpenRouter is an Anthropic model, which takes cache_control marks. */
export function isOpenRouterAnthropicModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('anthropic/');
}

const ModelList = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(200),
      name: z.string().max(300).nullish(),
      context_length: z.number().nullish(),
      // The request parameters the model takes (`reasoning`, `include_reasoning`, `tools`...).
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

/** A window within the limits Settings accepts, else null (the Admin sets it). */
function windowOf(contextLength: number | null | undefined): number | null {
  if (typeof contextLength !== 'number' || !Number.isInteger(contextLength)) return null;
  if (contextLength < CONTEXT_WINDOW_LIMITS.min || contextLength > CONTEXT_WINDOW_LIMITS.max) {
    return null;
  }
  return contextLength;
}

/** How long the model list may take before the picker falls back to typing the id. */
export const OPENROUTER_LIST_TIMEOUT_MS = 10_000;

type ListedModel = z.infer<typeof ModelList>['data'][number];

/** OpenRouter's model list as sent, or why it couldn't be read. Never throws. */
async function fetchOpenRouterModels(
  env: Record<string, string | undefined>,
): Promise<{ models: ListedModel[]; error: string | null }> {
  try {
    const res = await fetch(`${openRouterBaseUrl(env)}/models`, {
      headers: { accept: 'application/json', ...openRouterHeaders(env) },
      redirect: 'error',
      signal: AbortSignal.timeout(OPENROUTER_LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { models: [], error: `OpenRouter answered ${res.status} for its model list` };
    }
    const parsed = ModelList.safeParse(await res.json());
    if (!parsed.success) {
      return { models: [], error: 'OpenRouter sent a model list Vorasaan could not read' };
    }
    return { models: parsed.data.data, error: null };
  } catch (error) {
    const reason =
      (error as Error)?.name === 'TimeoutError'
        ? 'it took too long'
        : ((error as Error)?.message ?? 'unknown error');
    return { models: [], error: `Could not load OpenRouter's model list: ${reason}` };
  }
}

/**
 * OpenRouter's model list (`GET /models`), sorted by name. The list is public, so
 * no key is sent with it. Never throws: a failure is the `error` of the view.
 */
export async function listOpenRouterModels(
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderModelsView> {
  const { models, error } = await fetchOpenRouterModels(env);
  return {
    models: models
      .map((m) => ({
        id: m.id,
        name: m.name?.trim() || m.id,
        contextWindow: windowOf(m.context_length),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    error,
  };
}

/** What OpenRouter's list says of one model id: nulls when not listed, or no list. */
export type OpenRouterModelInfo = {
  contextWindow: number | null;
  /**
   * Whether the model takes a reasoning parameter (ticket 0081): its `supported_parameters`
   * name `reasoning` or `include_reasoning`. Null when the list doesn't say.
   */
  supportsReasoning: boolean | null;
};

/** One model's window and reasoning support, from one read of OpenRouter's list. */
export async function openRouterModelInfo(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<OpenRouterModelInfo> {
  const { models } = await fetchOpenRouterModels(env);
  const listed = models.find((m) => m.id === modelId.trim());
  const parameters = listed?.supported_parameters;
  return {
    contextWindow: windowOf(listed?.context_length),
    supportsReasoning: parameters
      ? parameters.includes('reasoning') || parameters.includes('include_reasoning')
      : null,
  };
}

/** The window OpenRouter's list gives a model id, or null (not listed, or no list). */
export async function openRouterContextWindow(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<number | null> {
  return (await openRouterModelInfo(modelId, env)).contextWindow;
}
