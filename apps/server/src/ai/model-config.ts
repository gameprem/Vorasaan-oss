import type { AiProvider } from '@vorasaan/shared';
import { openRouterHeaders } from './openrouter.ts';

/** A provider configuration with its secret decrypted, ready to call. */
export type ResolvedProvider = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
};

/**
 * What Mastra's Agent accepts as `model`: a "provider/model" string that reads
 * its key from env, a "provider/model" config with an explicit key (and headers),
 * or an OpenAI-compatible config with its own URL.
 */
export type MastraModel =
  | string
  | { id: `${string}/${string}`; apiKey: string; headers?: Record<string, string> }
  | { providerId: string; modelId: string; url: string; apiKey: string };

export function toMastraModel(p: ResolvedProvider): MastraModel {
  switch (p.provider) {
    case 'ANTHROPIC':
      return { id: `anthropic/${p.model}`, apiKey: p.apiKey };
    case 'OPENAI':
      return { id: `openai/${p.model}`, apiKey: p.apiKey };
    case 'OPENAI_COMPATIBLE':
      if (!p.baseUrl) throw new Error('A custom provider needs a base URL');
      return { providerId: 'custom', modelId: p.model, url: p.baseUrl, apiKey: p.apiKey };
    case 'OPENROUTER':
      // Mastra's OpenRouter provider (ticket 0064): OpenRouter's fixed URL (or the
      // operator's OPENROUTER_BASE_URL), never a stored one. No `url` here, or Mastra
      // would fall back to its generic OpenAI-compatible provider, which can't mark
      // system blocks for caching.
      return { id: `openrouter/${p.model}`, apiKey: p.apiKey, headers: openRouterHeaders() };
    case 'GEMINI':
      // Mastra's Google provider (ticket 0080): the Gemini API's fixed URL (or the
      // operator's GOOGLE_BASE_URL), never a stored one. No `url` here, or Mastra would
      // send it through its generic OpenAI-compatible provider instead.
      return { id: `google/${p.model}`, apiKey: p.apiKey };
  }
}

/** The Mastra model for one call's chosen model (a `ModelChoice`). */
export function mastraModelOf(choice: {
  provider: ResolvedProvider | null;
  name: string;
}): MastraModel {
  if (choice.provider) return toMastraModel(choice.provider);
  // An env "openrouter/…" model with the env key: the OpenRouter headers still go along.
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (choice.name.startsWith('openrouter/') && envKey) {
    return {
      id: choice.name as `openrouter/${string}`,
      apiKey: envKey,
      headers: openRouterHeaders(),
    };
  }
  return choice.name;
}

/** How much a Gemini model thinks (`VORASAAN_GEMINI_THINKING`, ticket 0080). */
export type GeminiThinking = 'low' | 'high' | 'default';

/** The operator's choice; anything but `high` or `default` is the default, `low`. */
export function geminiThinking(env: NodeJS.ProcessEnv = process.env): GeminiThinking {
  const value = env.VORASAAN_GEMINI_THINKING?.trim().toLowerCase();
  return value === 'high' || value === 'default' ? value : 'low';
}

/** Gemini's thinking settings, as the AI SDK's Google provider takes them. */
export type GeminiThinkingConfig = { thinkingLevel: 'low' | 'high' } | { thinkingBudget: number };

/** Per-call provider options for Mastra's `agent.stream`: today only Gemini's thinking. */
export type ModelProviderOptions = { google: { thinkingConfig: GeminiThinkingConfig } };

/**
 * Gemini's thinking for one model id (without `google/`), or null to send nothing.
 * Thinking tokens bill as output, and Gemini 3 thinks by default, so Vorasaan's
 * structured tasks and chat ask for little of it (ticket 0080):
 * - `gemini-2.5-…` takes a budget: 0 turns it off on Flash and Flash-Lite; Pro needs 128 or more.
 * - Older Gemini models (`gemini-1.…`, `gemini-2.0-…`) don't think: nothing.
 * - Every other `gemini-…` (Gemini 3 and later, `gemini-flash-latest`, `gemini-pro-latest`)
 *   takes a level; `minimal` isn't accepted by every model, `low` is.
 * - Anything else (Gemma, `gemma-…`) refuses thinking settings: nothing.
 * `high` asks Gemini 3 for its most thinking and leaves 2.5's own dynamic thinking;
 * `default` sends nothing at all.
 */
export function geminiThinkingConfig(
  modelId: string,
  thinking: GeminiThinking = geminiThinking(),
): GeminiThinkingConfig | null {
  const id = modelId.trim().toLowerCase();
  if (thinking === 'default' || !id.startsWith('gemini-')) return null;
  if (/^gemini-(1\.|2\.0)/.test(id)) return null;
  if (id.startsWith('gemini-2.')) {
    if (thinking === 'high') return null;
    return { thinkingBudget: id.includes('-pro') ? 128 : 0 };
  }
  return { thinkingLevel: thinking };
}

/**
 * The provider options every call on this model carries (structured tasks, chat, the
 * connection test), or null. Only Gemini models through Mastra's Google provider
 * (`google/…`, an Approved Model or a `VORASAAN_MODEL*` env model) get any; other
 * providers' calls are unchanged.
 */
export function providerOptionsOf(
  model: MastraModel,
  thinking: GeminiThinking = geminiThinking(),
): ModelProviderOptions | null {
  if (typeof model !== 'string' && !('id' in model)) return null;
  const id = typeof model === 'string' ? model : model.id;
  if (!id.toLowerCase().startsWith('google/')) return null;
  const thinkingConfig = geminiThinkingConfig(id.slice('google/'.length), thinking);
  return thinkingConfig ? { google: { thinkingConfig } } : null;
}
