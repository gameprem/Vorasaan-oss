/**
 * Cuts Markdown (or plain text) into chunks for embedding (ADR 0007).
 *
 * - Sections start at ATX headings (`#`..`######`) outside fenced code blocks.
 * - Consecutive small sections are packed together up to the target size.
 * - A section longer than the target is split by paragraph (then at word
 *   boundaries); every piece repeats the section's heading line, and starts with
 *   the last ~`overlapTokens` of the piece before it, so a sentence cut at a
 *   boundary is still found whole in one of the two chunks.
 *
 * Sizes are the script-aware estimate (token-estimate.ts): close enough for
 * budgeting, with no tokenizer dependency. No chunk is longer than
 * `targetTokens`, in Thai as in English. Text without Thai is cut exactly where
 * it was at four characters per token; Thai is cut into more, smaller chunks.
 */

import {
  estimateTokens,
  fitsTokens,
  prefixWithin,
  suffixWithin,
  tokenCost,
} from './token-estimate.ts';

export const CHUNKING = { targetTokens: 400, overlapTokens: 50 } as const;

export type ChunkingOptions = { targetTokens: number; overlapTokens: number };

export type TextChunk = { position: number; text: string; tokenCount: number };

export function chunkMarkdown(
  markdown: string,
  options: Partial<ChunkingOptions> = {},
): TextChunk[] {
  const { targetTokens, overlapTokens } = { ...CHUNKING, ...options };
  const maxTokens = Math.max(1, targetTokens);
  // Overlap may take at most a quarter of a chunk, so every chunk adds new text.
  const overlap = Math.min(Math.max(0, overlapTokens), maxTokens / 4);

  const texts: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) texts.push(buffer);
    buffer = '';
  };
  for (const section of sections(markdown.replace(/\r\n?/g, '\n'))) {
    if (!fitsTokens(section.text, maxTokens)) {
      flush();
      texts.push(...splitSection(section, maxTokens, overlap));
      continue;
    }
    const joined = buffer ? `${buffer}\n\n${section.text}` : section.text;
    if (!fitsTokens(joined, maxTokens)) {
      flush();
      buffer = section.text;
    } else {
      buffer = joined;
    }
  }
  flush();
  return texts.map((text, position) => ({ position, text, tokenCount: estimateTokens(text) }));
}

type Section = { heading: string | null; text: string };

const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function sections(text: string): Section[] {
  const out: Section[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let fence: string | null = null;
  const push = () => {
    const body = lines.join('\n').trim();
    if (body) out.push({ heading, text: body });
  };
  for (const line of text.split('\n')) {
    const marker = line.match(FENCE)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
    } else if (!fence && HEADING.test(line)) {
      push();
      heading = line.trim();
      lines = [];
    }
    lines.push(line);
  }
  push();
  return out;
}

/** Two newlines join paragraphs; they cost as much as two Latin characters. */
const PARAGRAPH_BREAK_TOKENS = tokenCost('\n\n');

function splitSection(section: Section, maxTokens: number, overlap: number): string[] {
  let prefix = '';
  let body = section.text;
  const newline = section.text.indexOf('\n');
  // Repeat the heading on every piece, unless the heading itself is most of a chunk.
  if (
    section.heading &&
    newline !== -1 &&
    fitsTokens(section.text.slice(0, newline + 1), maxTokens / 4)
  ) {
    prefix = `${section.text.slice(0, newline)}\n`;
    body = section.text.slice(newline + 1).trim();
  }
  const budget = maxTokens - tokenCost(prefix);
  const hardSize = budget - overlap - PARAGRAPH_BREAK_TOKENS;

  const units = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (fitsTokens(p, budget) ? [p] : hardSplit(p, hardSize)));

  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (fitsTokens(joined, budget)) {
      current = joined;
      continue;
    }
    pieces.push(current);
    const tail = overlapTail(current, overlap);
    const withTail = `${tail}\n\n${unit}`;
    current = tail && fitsTokens(withTail, budget) ? withTail : unit;
  }
  if (current) pieces.push(current);
  return pieces.map((piece) => prefix + piece);
}

/** The last ~`tokens` tokens of `text`, starting at a word boundary. */
function overlapTail(text: string, tokens: number): string {
  if (tokens <= 0 || fitsTokens(text, tokens)) return '';
  const slice = text.slice(suffixWithin(text, tokens));
  const cut = slice.search(/\s/);
  return cut === -1 ? '' : slice.slice(cut).trim();
}

/** Thai vowels and tone marks written above or below the consonant before them. */
const THAI_MARK = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

/** Pieces of at most `size` tokens, cut at whitespace when there is any nearby. */
function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (!fitsTokens(rest, size)) {
    // At least one character per piece, so a tiny `size` still ends.
    const end = Math.max(1, prefixWithin(rest, size));
    const half = prefixWithin(rest, size / 2);
    let cut = end;
    for (let i = end; i > half; i--) {
      if (/\s/.test(rest[i] ?? '')) {
        cut = i;
        break;
      }
    }
    // Never strand a Thai vowel or tone mark at the start of the next piece.
    while (cut > 1 && THAI_MARK.test(rest[cut] ?? '')) cut--;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
