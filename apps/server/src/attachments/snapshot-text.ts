import { ATTACHMENT_FILE_TYPES } from '@vorasaan/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { htmlToText } from './html-to-text.ts';

/** The content can't be turned into a Snapshot (not what it claims to be, or unreadable). */
export class UnreadableContentError extends Error {}

export const TRUNCATION_MARKER = '\n\n[Snapshot truncated]';

/** The media type an uploaded file name maps to, or null when the type isn't accepted. */
export function mimeTypeForFileName(name: string): string | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return Object.hasOwn(ATTACHMENT_FILE_TYPES, extension)
    ? ATTACHMENT_FILE_TYPES[extension as keyof typeof ATTACHMENT_FILE_TYPES]
    : null;
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'application/pdf': (b) => ascii(b, 0, 5) === '%PDF-',
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
};

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Binary types must start with their magic number, so the extension can't lie. */
export function matchesMimeType(bytes: Uint8Array, mimeType: string): boolean {
  const check = MAGIC[mimeType];
  return check ? check(bytes) : true;
}

/**
 * The Snapshot text of some bytes: Markdown and plain text as-is, PDF and HTML as
 * extracted text, images as null (the AI only sees their title). Capped at `maxChars`.
 */
export async function snapshotText(
  bytes: Uint8Array,
  mimeType: string,
  maxChars: number,
): Promise<string | null> {
  const text = await extract(bytes, mimeType);
  return text === null ? null : capSnapshot(text, maxChars);
}

export function capSnapshot(text: string, maxChars: number): string {
  // Postgres text can't hold NUL characters (a web page or PDF may contain them).
  const clean = text.replaceAll('\0', '');
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars) + TRUNCATION_MARKER;
}

async function extract(bytes: Uint8Array, mimeType: string): Promise<string | null> {
  if (mimeType.startsWith('image/')) return null;
  if (mimeType === 'application/pdf') return pdfText(bytes);
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    return htmlToText(decodeUtf8(bytes, false)).text;
  }
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') {
    const text = decodeUtf8(bytes, true);
    if (text.includes('\0')) throw new UnreadableContentError('This is not a text file');
    return text;
  }
  throw new UnreadableContentError(`Can't read text from ${mimeType}`);
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  try {
    // Strips a leading byte order mark.
    return new TextDecoder('utf-8', { fatal }).decode(bytes);
  } catch {
    throw new UnreadableContentError('Text files must be UTF-8');
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    // A plain Uint8Array copy: pdf.js refuses Buffers and may detach what it's given.
    // verbosity 0: errors only, no pdf.js warnings in the server log.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  } catch {
    throw new UnreadableContentError('Could not read text from this PDF');
  }
}
