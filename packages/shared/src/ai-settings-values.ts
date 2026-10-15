import type { AiProvider, AiTask, ReasoningLevel } from './ai-settings.ts';

// Plain values of ai-settings.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  ANTHROPIC: 'claude-opus-5-5',
  OPENAI: 'gpt-5.6-sol',
  OPENAI_COMPATIBLE: '',
  // Picked from OpenRouter's model list (ticket 0064).
  OPENROUTER: '',
  // Picked from the Gemini API's model list (ticket 0080).
  GEMINI: '',
};

/** The name a provider gets when none is given (setup, and the migrated provider). */
export const DEFAULT_PROVIDER_NAMES: Record<AiProvider, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
  OPENAI_COMPATIBLE: 'Custom endpoint',
  OPENROUTER: 'OpenRouter',
  GEMINI: 'Gemini',
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
  // Gemini's input token limit (ticket 0080); the model list gives the exact one.
  [/^gemini-1\.5-pro/, 2_097_152],
  [/^gemini-/, 1_048_576],
];

/** The context window of a known model id (a "provider/" prefix is allowed), or null. */
export function knownContextWindow(modelId: string): number | null {
  const id = modelId
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, '');
  return KNOWN_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

/** The most a million tokens may cost (US dollars): a typo guard, far above any real price. */
export const MAX_PRICE_PER_MILLION = 10_000;

/**
 * The Reasoning Level each task runs at until an Admin sets one (ticket 0081): low for the
 * structured tasks, medium for chat, a Spec drafted from Attachments and Design Docs.
 * `note` names the calls of the task with another default.
 */
export const REASONING_DEFAULTS: Record<AiTask, { level: ReasoningLevel; note: string | null }> = {
  CHOICES: { level: 'LOW', note: null },
  SPEC_PROPOSAL: { level: 'LOW', note: 'Medium for a Spec drafted from Attachments' },
  SUMMARIES: { level: 'LOW', note: null },
  GRILLING: { level: 'LOW', note: null },
  FEATURE_SUGGESTIONS: { level: 'LOW', note: null },
  FIT_CHECK: { level: 'LOW', note: null },
  CHAT: { level: 'MEDIUM', note: null },
  PROMPT_PROPOSALS: { level: 'LOW', note: null },
  DESIGN_DOCS: { level: 'MEDIUM', note: 'Low for Redrafts' },
};
