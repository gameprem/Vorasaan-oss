import type { ContextBlock } from '../ai/ai.port.ts';

// Deduplicating retrieved context (ticket 0076): one call never sends the same text twice.
// Blocks with the same chunk, source or text were already dropped (`dedupe` in the
// retriever); this also catches text repeated inside different blocks:
// - a chunk whose text an earlier block already holds whole: another copy of a section
//   (an "archive" or "appendix" copy, the same paragraph in two documents), or a Spec's
//   first chunk inside the start of that Spec shown in a Project's Feature overview;
// - the start or the end of a chunk that an earlier block repeats: the overlap the chunker
//   gives the pieces of a long section (ADR 0007), whichever piece came first. That part
//   is cut, the chunk's heading line kept, and "…" marks each cut.

/** A repeated start or end shorter than this is kept: a heading, a common phrase. */
export const MIN_REPEAT_CHARS = 80;
/** A chunk with less new text than this, once its repeated parts are cut, adds nothing. */
export const MIN_NEW_CHARS = 80;

/** A block already in the prompt: its text, and its text with whitespace squashed. */
export type ShownText = { text: string; flat: string };

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

export function shown(block: Pick<ContextBlock, 'text'>): ShownText {
  return { text: block.text, flat: squash(block.text) };
}

/** A chunk's Markdown heading line (the chunker repeats it on every piece of a section), and the rest. */
export function splitHeading(text: string): { heading: string | null; body: string } {
  const match = text.match(/^ {0,3}#{1,6}[^\n]*\n/);
  if (!match) return { heading: null, body: text };
  return { heading: match[0].trimEnd(), body: text.slice(match[0].length) };
}

/** The length of the longest start of `text` that one of `texts` contains. */
function repeatedStart(text: string, texts: string[]): number {
  // Containment of a start only shrinks as the start grows, so a binary search finds it.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const start = text.slice(0, mid);
    if (texts.some((t) => t.includes(start))) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The length of the longest end of `text` that one of `texts` contains. */
function repeatedEnd(text: string, texts: string[]): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const end = text.slice(text.length - mid);
    if (texts.some((t) => t.includes(end))) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Where to cut `text` near `at`: the nearest line break within the repeat, else between words. */
function boundary(text: string, at: number, towardStart: boolean): number {
  if (towardStart) {
    const line = text.lastIndexOf('\n', at);
    if (line >= MIN_REPEAT_CHARS) return line;
    let cut = at;
    while (cut > 0 && !/\s/.test(text[cut] ?? ' ')) cut--;
    return cut;
  }
  const line = text.indexOf('\n', at);
  if (line !== -1 && text.length - line >= MIN_REPEAT_CHARS) return line;
  let cut = at;
  while (cut < text.length && !/\s/.test(text[cut - 1] ?? ' ')) cut++;
  return cut;
}

/**
 * A chunk's text without what the prompt already shows: null when an earlier block holds
 * all of it (its heading aside), else the text with a start or an end that an earlier
 * block repeats cut, "…" marking each cut (null when too little new text is left).
 */
export function unrepeated(block: Pick<ContextBlock, 'text'>, before: ShownText[]): string | null {
  const { heading, body } = splitHeading(block.text);
  const flat = squash(body);
  if (!flat) return null;
  // A short text (a "TBD", a one-word answer) is found inside others by chance: kept.
  if (flat.length >= MIN_REPEAT_CHARS && before.some((s) => s.flat.includes(flat))) return null;
  if (!before.length) return block.text;
  const texts = before.map((s) => s.text);
  let rest = body.trim();
  let cutStart = false;
  let cutEnd = false;
  const start = repeatedStart(rest, texts);
  if (start >= MIN_REPEAT_CHARS) {
    rest = rest.slice(boundary(rest, start, true)).trim();
    cutStart = true;
  }
  const end = repeatedEnd(rest, texts);
  if (end >= MIN_REPEAT_CHARS) {
    rest = rest.slice(0, boundary(rest, rest.length - end, false)).trim();
    cutEnd = true;
  }
  if (!cutStart && !cutEnd) return block.text;
  // What is left may sit whole in another block (a copy cut from a different place).
  const left = squash(rest);
  if (left.length < MIN_NEW_CHARS || before.some((s) => s.flat.includes(left))) return null;
  const text = `${cutStart ? '…\n' : ''}${rest}${cutEnd ? '\n…' : ''}`;
  return heading ? `${heading}\n${text}` : text;
}

/**
 * Blocks without those whose text `shownTexts` already hold (heading aside): for a prompt
 * that shows some records in their own section, such as the Decision Log of Feature
 * Suggestions, whose Decisions retrieval may also find.
 */
export function withoutShown(blocks: ContextBlock[], shownTexts: string[]): ContextBlock[] {
  const flats = shownTexts.map(squash);
  return blocks.filter((b) => {
    const flat = squash(splitHeading(b.text).body);
    return flat.length < MIN_REPEAT_CHARS || !flats.some((s) => s.includes(flat));
  });
}
