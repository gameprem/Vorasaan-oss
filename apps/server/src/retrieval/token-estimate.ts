import { CONTEXT_TRUNCATION_MARKER } from '../attachments/attachment-context.ts';

/**
 * Token estimates that hold for Thai as well as English (ADR 0012, ticket 0059),
 * with no tokenizer dependency: each character costs a fixed share of a token by
 * its script. Thai has no spaces and stacks vowels and tone marks, so it costs
 * a little over one token per character; Latin text and everything else about
 * four characters per token, exactly as before.
 *
 * Tuned on token-fixture.ts against cl100k_base, the densest of the well-known
 * tokenizers for Thai, so the estimate stays at or a little above the real count
 * of Thai and mixed Thai-English text, and a budget filled with Thai holds. The
 * measured error is in ticket 0059.
 */
export const CHARS_PER_TOKEN = {
  /** The Thai block, U+0E00 to U+0E7F: consonants, vowels, tone marks, digits. */
  thai: 0.95,
  /** Everything else, Latin text included. */
  other: 4,
} as const;

const THAI_COST = 1 / CHARS_PER_TOKEN.thai;
const OTHER_COST = 1 / CHARS_PER_TOKEN.other;
/** Floating-point slack, so 950 Thai characters cost 1,000 tokens, not 1,000.0000001. */
const EPSILON = 1e-9;

function isThai(code: number): boolean {
  return code >= 0x0e00 && code <= 0x0e7f;
}

/** What `thai` Thai characters and `other` other characters cost, unrounded. */
function cost(thai: number, other: number): number {
  return thai * THAI_COST + other * OTHER_COST;
}

/** The unrounded estimate: what `text` costs, in tokens. */
export function tokenCost(text: string): number {
  let thai = 0;
  for (let i = 0; i < text.length; i++) if (isThai(text.charCodeAt(i))) thai++;
  return cost(thai, text.length - thai);
}

/** About how many tokens `text` is, rounded up. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(tokenCost(text) - EPSILON));
}

/** The length of the longest start of `text` that costs at most `maxTokens`. */
export function prefixWithin(text: string, maxTokens: number): number {
  let thai = 0;
  for (let i = 0; i < text.length; i++) {
    if (isThai(text.charCodeAt(i))) thai++;
    if (cost(thai, i + 1 - thai) > maxTokens + EPSILON) return i;
  }
  return text.length;
}

/** Where the longest end of `text` that costs at most `maxTokens` starts. */
export function suffixWithin(text: string, maxTokens: number): number {
  let thai = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (isThai(text.charCodeAt(i))) thai++;
    if (cost(thai, text.length - i - thai) > maxTokens + EPSILON) return i + 1;
  }
  return 0;
}

/** Whether `text` costs at most `maxTokens`; stops reading as soon as it doesn't. */
export function fitsTokens(text: string, maxTokens: number): boolean {
  return prefixWithin(text, maxTokens) === text.length;
}

const MARKER_TOKENS = tokenCost(CONTEXT_TRUNCATION_MARKER);

/**
 * Cuts `text` to at most `maxTokens` estimated tokens, with the truncation
 * marker when there is room for it: `clipForAi`, counted in tokens instead of
 * characters (the same cut for text without Thai).
 */
export function clipToTokens(text: string, maxTokens: number): string {
  const max = Math.max(0, Math.floor(maxTokens));
  if (fitsTokens(text, max)) return text;
  if (max < MARKER_TOKENS) return text.slice(0, prefixWithin(text, max));
  return text.slice(0, prefixWithin(text, max - MARKER_TOKENS)) + CONTEXT_TRUNCATION_MARKER;
}
