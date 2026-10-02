/**
 * How many characters of one Attachment's text summarising it may send. Other AI
 * tasks get their Attachment context from the ContextRetriever (ADR 0007).
 */
export const ATTACHMENT_CONTEXT_BUDGET = {
  /** Summarising one Attachment. */
  summary: 60_000,
} as const;

export const CONTEXT_TRUNCATION_MARKER = '\n[Shortened to fit the AI context budget]';

/** Cuts `text` to at most `maxChars` characters, marker included when there is room for it. */
export function clipForAi(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const max = Math.max(0, Math.floor(maxChars));
  if (max < CONTEXT_TRUNCATION_MARKER.length) return text.slice(0, max);
  return text.slice(0, max - CONTEXT_TRUNCATION_MARKER.length) + CONTEXT_TRUNCATION_MARKER;
}
