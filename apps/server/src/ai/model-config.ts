import type { AiProvider } from '@vorasaan/shared';

/** A provider configuration with its secret decrypted, ready to call. */
export type ResolvedProvider = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
};

/**
 * What Mastra's Agent accepts as `model`: a "provider/model" string that reads
 * its key from env, or an OpenAI-compatible config object with an explicit key.
 */
export type MastraModel =
  | string
  | { id: `${string}/${string}`; apiKey: string }
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
  }
}

/** The Mastra model for one call's chosen model (a `ModelChoice`). */
export function mastraModelOf(choice: {
  provider: ResolvedProvider | null;
  name: string;
}): MastraModel {
  return choice.provider ? toMastraModel(choice.provider) : choice.name;
}
