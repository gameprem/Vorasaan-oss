import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import type { MastraModel } from './model-config.ts';

// Prompt caching (ticket 0061, ADR 0012). Every prompt is ordered stable to
// volatile: the instructions, then the Project Brief and the Guidelines, then the
// Feature's Spec, then retrieved context, then history and the new input. A
// prompt is cut where a stable part ends; on Anthropic each cut becomes a
// cache_control breakpoint, so the next call with the same prefix reads it from
// the cache, and so on an Anthropic model routed through OpenRouter (ticket 0064).
// Every other provider gets the whole text as before (OpenAI caches the longest
// repeated prefix by itself, so it only needs the order, and so does Gemini's
// implicit caching, ticket 0080).

/**
 * A prompt and the same text cut at its cache breakpoints: `parts.join('')` is
 * `text`, and every part but the last ends a stable prefix.
 */
export type Prompt = { text: string; parts: string[] };

/**
 * Where a stable prefix ends: the `{{cacheBreak}}` of a prompt template, or a
 * break the server puts inside a value (after the Feature's Spec or the Brief in
 * the context). Random per process, so no text from a document or a person can
 * forge one; it never reaches a provider.
 */
export const CACHE_BREAK = `\u0000cache-break-${randomUUID()}\u0000`;

/** Anthropic allows at most four breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * A prefix shorter than this is never marked. It is the smallest minimum among
 * current Anthropic models; on a model whose minimum is higher (up to 4,096) a
 * shorter prefix is simply not cached, with no error and no extra cost.
 */
export const MIN_CACHE_PREFIX_TOKENS = 512;

/** A rendered prompt (with its CACHE_BREAKs) as a Prompt. Empty parts are dropped. */
export function splitPrompt(rendered: string): Prompt {
  const parts = rendered.split(CACHE_BREAK).filter((p) => p.length > 0);
  return { text: parts.join(''), parts };
}

/** A prompt with no breakpoint: nothing in it is stable from call to call. */
export function wholePrompt(text: string): Prompt {
  return { text, parts: text ? [text] : [] };
}

/**
 * The indexes of the parts to mark for caching: every part but the last whose
 * prefix (it and the parts before it) is long enough to cache, at most
 * MAX_CACHE_BREAKPOINTS of them, the longest prefixes kept. `fixedTokens` is
 * what comes before the parts in the request (a system prompt, for instance).
 */
export function cacheBreakpoints(parts: string[], fixedTokens = 0): number[] {
  const marked: number[] = [];
  let prefix = fixedTokens;
  for (let i = 0; i < parts.length - 1; i++) {
    prefix += estimateTokens(parts[i] ?? '');
    if (prefix >= MIN_CACHE_PREFIX_TOKENS) marked.push(i);
  }
  return marked.slice(-MAX_CACHE_BREAKPOINTS);
}

/** The AI SDK provider option that becomes Anthropic's `cache_control`. */
export const ANTHROPIC_CACHE_MARK = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

/**
 * The provider option Mastra's OpenRouter provider turns into `cache_control` on a
 * content part (ticket 0064), system blocks included. OpenRouter passes it on to
 * Anthropic, with Anthropic's rules (512 tokens and up, at most four marks).
 */
export const OPENROUTER_CACHE_MARK = {
  openrouter: { cacheControl: { type: 'ephemeral' } },
} as const;

export type CacheMark = typeof ANTHROPIC_CACHE_MARK | typeof OPENROUTER_CACHE_MARK;

/**
 * Whether Mastra calls this model through its Anthropic provider (the Messages
 * API, which takes cache_control). A config with its own `url` goes through the
 * OpenAI-compatible provider instead, whatever its id says.
 */
export function isAnthropicModel(model: MastraModel): boolean {
  return routerId(model)?.startsWith('anthropic/') ?? false;
}

/** The "provider/model" id Mastra routes by, or null for a config with its own URL. */
function routerId(model: MastraModel): string | null {
  if (typeof model === 'string') return model.toLowerCase();
  if ('url' in model && model.url) return null;
  return 'id' in model ? model.id.toLowerCase() : null;
}

/**
 * The mark for this model's stable parts, or null when it gets the plain text:
 * Anthropic's for an Anthropic model, OpenRouter's for an Anthropic model routed
 * through OpenRouter (`openrouter/anthropic/...`). Every other model caches by itself
 * (OpenAI; Gemini's implicit caching, `google/...`, ticket 0080) or not at all, and
 * gets the prompt as before.
 */
export function cacheMarkOf(model: MastraModel): CacheMark | null {
  const id = routerId(model);
  if (!id) return null;
  if (id.startsWith('anthropic/')) return ANTHROPIC_CACHE_MARK;
  if (id.startsWith('openrouter/anthropic/')) return OPENROUTER_CACHE_MARK;
  return null;
}

type TextPart = { type: 'text'; text: string; providerOptions?: CacheMark };

/** A one-shot task's prompt as one user message, its stable parts marked. */
export function markedUserMessage(
  prompt: Prompt,
  mark: CacheMark,
  fixedTokens = 0,
): { role: 'user'; content: TextPart[] } {
  const marked = new Set(cacheBreakpoints(prompt.parts, fixedTokens));
  return {
    role: 'user',
    content: prompt.parts.map((text, i) => ({
      type: 'text' as const,
      text,
      ...(marked.has(i) ? { providerOptions: mark } : {}),
    })),
  };
}

type SystemPart = {
  role: 'system';
  content: string;
  providerOptions?: CacheMark;
};

/** A chat's system prompt as system blocks, its stable parts marked. */
export function markedSystem(prompt: Prompt, mark: CacheMark): SystemPart[] {
  const marked = new Set(cacheBreakpoints(prompt.parts));
  return prompt.parts.map((content, i) => ({
    role: 'system' as const,
    content,
    ...(marked.has(i) ? { providerOptions: mark } : {}),
  }));
}

/** One call's token usage, with what the provider read from and wrote to its cache. */
export type CacheUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The usage the AI SDK reports for a call: `cachedInputTokens` (Anthropic's
 * `cache_read_input_tokens`, OpenAI's and OpenRouter's `cached_tokens`, Gemini's
 * `cachedContentTokenCount`) and, for
 * Anthropic and OpenRouter (`cache_write_tokens`), `cacheCreationInputTokens`; the
 * v3 `inputTokens` details as a fallback.
 */
export function cacheUsageOf(usage: unknown): CacheUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const raw = (u.raw ?? {}) as { inputTokens?: Record<string, unknown> };
  const details = raw.inputTokens ?? {};
  return {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cacheReadTokens: count(u.cachedInputTokens) ?? count(details.cacheRead),
    cacheWriteTokens: count(u.cacheCreationInputTokens) ?? count(details.cacheWrite),
  };
}

const logger = new Logger('AiUsage');

/**
 * Logs one AI call's usage and cache hits, e.g.
 * `chat: input 2410 (cache read 1980, cache write 0), output 112`. Never throws.
 */
export function logCacheUsage(task: string, usage: unknown): CacheUsage {
  const u = cacheUsageOf(usage);
  const n = (v: number | null) => (v === null ? '?' : String(v));
  logger.log(
    `${task}: input ${n(u.inputTokens)} (cache read ${n(u.cacheReadTokens)}, ` +
      `cache write ${n(u.cacheWriteTokens)}), output ${n(u.outputTokens)}`,
  );
  return u;
}
