import type { AiProvider } from '@vorasaan/shared';
import { openRouterHeaders } from './openrouter.ts';

/** A provider configuration with its secret decrypted, ready to call. */
export type ResolvedProvider = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  /**
   * Whether the model takes a reasoning parameter, as its Approved Model recorded it from
   * OpenRouter's model list (ticket 0081); null or left out: not known.
   */
  supportsReasoning?: boolean | null;
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
