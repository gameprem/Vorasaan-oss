/**
 * One canonical shape for stored Spec Markdown (ADR 0002): LF line endings, no
 * trailing whitespace at the end, exactly one final newline. Without this, diffs
 * between a hand-written version and an AI draft show phantom changes.
 */
export function normalizeMarkdown(markdown: string): string {
  return `${markdown.replace(/\r\n?/g, '\n').trimEnd()}\n`;
}
