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
 * Sizes are estimated at 4 characters per token: close enough for budgeting,
 * with no tokenizer dependency. No chunk is longer than `targetTokens`.
 */

export const CHUNKING = { targetTokens: 400, overlapTokens: 50 } as const;

export type ChunkingOptions = { targetTokens: number; overlapTokens: number };

export type TextChunk = { position: number; text: string; tokenCount: number };

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function chunkMarkdown(
  markdown: string,
  options: Partial<ChunkingOptions> = {},
): TextChunk[] {
  const { targetTokens, overlapTokens } = { ...CHUNKING, ...options };
  const maxChars = Math.max(1, targetTokens) * CHARS_PER_TOKEN;
  // Overlap may take at most a quarter of a chunk, so every chunk adds new text.
  const overlapChars = Math.min(Math.max(0, overlapTokens) * CHARS_PER_TOKEN, maxChars / 4);

  const texts: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) texts.push(buffer);
    buffer = '';
  };
  for (const section of sections(markdown.replace(/\r\n?/g, '\n'))) {
    if (section.text.length > maxChars) {
      flush();
      texts.push(...splitSection(section, maxChars, overlapChars));
      continue;
    }
    const joined = buffer ? `${buffer}\n\n${section.text}` : section.text;
    if (joined.length > maxChars) {
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

function splitSection(section: Section, maxChars: number, overlapChars: number): string[] {
  let prefix = '';
  let body = section.text;
  const newline = section.text.indexOf('\n');
  // Repeat the heading on every piece, unless the heading itself is most of a chunk.
  if (section.heading && newline !== -1 && newline + 1 <= maxChars / 4) {
    prefix = `${section.text.slice(0, newline)}\n`;
    body = section.text.slice(newline + 1).trim();
  }
  const budget = maxChars - prefix.length;
  const hardSize = Math.max(1, Math.floor(budget - overlapChars - 2));

  const units = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > budget ? hardSplit(p, hardSize) : [p]));

  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length <= budget) {
      current = joined;
      continue;
    }
    pieces.push(current);
    const tail = overlapTail(current, overlapChars);
    current = tail && tail.length + 2 + unit.length <= budget ? `${tail}\n\n${unit}` : unit;
  }
  if (current) pieces.push(current);
  return pieces.map((piece) => prefix + piece);
}

/** The last ~`chars` characters of `text`, starting at a word boundary. */
function overlapTail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return '';
  const slice = text.slice(-chars);
  const cut = slice.search(/\s/);
  return cut === -1 ? '' : slice.slice(cut).trim();
}

/** Pieces of at most `size` characters, cut at whitespace when there is any nearby. */
function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = size;
    for (let i = size; i > size / 2; i--) {
      if (/\s/.test(rest[i] ?? '')) {
        cut = i;
        break;
      }
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
