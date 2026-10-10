import { crc32, inflateRawSync } from 'node:zlib';

// A small, strict zip reader for Agent Skills (ticket 0078): it lists entries from the central
// directory and inflates only the entries asked for, each capped, so a zip bomb or a lying
// header can't make it allocate more than the cap. Nothing in an archive is ever written to
// disk or run; paths that could escape a folder refuse the whole archive.

/** The archive can't be read safely (not a zip, ZIP64, an unsafe path, a bad entry...). */
export class ZipError extends Error {}

/** An entry inflates to more than the cap it was read with. */
export class ZipEntryTooLargeError extends ZipError {
  constructor(
    readonly path: string,
    readonly limit: number,
  ) {
    super(`"${path}" is larger than ${limit} bytes`);
  }
}

export type ZipEntry = {
  /** The entry's path, as stored: slash-separated, relative, checked safe. */
  path: string;
  directory: boolean;
  /** A symbolic link (Unix mode in the external attributes): never followed. */
  link: boolean;
  encrypted: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The most entries an archive may list (a GitHub repository zip of a Skill is far below). */
export const MAX_ZIP_ENTRIES = 20_000;

/**
 * Whether `path` stays inside the folder it is in: relative, slash-separated, no `.` or `..`
 * segment, no backslash, drive letter or NUL. Directory entries may end with one slash.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 1_000) return false;
  if (/[\\\0]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.replace(/\/$/, '').split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

function u16(view: DataView, at: number) {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number) {
  return view.getUint32(at, true);
}

/** Every entry of the archive, from its central directory. Throws `ZipError` when unsafe. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.byteLength < minEocd) throw new ZipError('This is not a zip file');
  let eocd = -1;
  const lowest = Math.max(0, bytes.byteLength - minEocd - 0xffff);
  for (let at = bytes.byteLength - minEocd; at >= lowest; at--) {
    if (u32(view, at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a zip file');
  const count = u16(view, eocd + 10);
  const size = u32(view, eocd + 12);
  const offset = u32(view, eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported');
  }
  if (count > MAX_ZIP_ENTRIES)
    throw new ZipError(`The zip lists more than ${MAX_ZIP_ENTRIES} files`);
  if (offset + size > eocd) throw new ZipError('The zip file is damaged');

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(view, at) !== CENTRAL) throw new ZipError('The zip file is damaged');
    const madeBy = u16(view, at + 4);
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    const crc = u32(view, at + 16);
    const compressedSize = u32(view, at + 20);
    const uncompressed = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const external = u32(view, at + 38);
    const localHeaderOffset = u32(view, at + 42);
    if (at + 46 + nameLength > eocd) throw new ZipError('The zip file is damaged');
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (!isSafeRelativePath(path)) {
      throw new ZipError(`The zip has a file outside its folder ("${path.slice(0, 120)}")`);
    }
    const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0o170000 : 0;
    entries.push({
      path: path.replace(/\/$/, ''),
      directory: path.endsWith('/') || unixMode === 0o040000,
      link: unixMode === 0o120000,
      encrypted: (flags & 1) === 1,
      method,
      crc,
      compressedSize,
      size: uncompressed,
      localHeaderOffset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes, inflated, at most `maxBytes` of them: the declared size is checked
 * first, and the inflater is capped too, so a lying header fails instead of growing.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Uint8Array {
  if (entry.directory || entry.link) throw new ZipError(`"${entry.path}" is not a file`);
  if (entry.encrypted) throw new ZipError(`"${entry.path}" is encrypted`);
  if (entry.size > maxBytes) throw new ZipEntryTooLargeError(entry.path, maxBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.byteLength || u32(view, at) !== LOCAL) {
    throw new ZipError('The zip file is damaged');
  }
  const start = at + 30 + u16(view, at + 26) + u16(view, at + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new ZipError('The zip file is damaged');
  const raw = bytes.subarray(start, end);
  let data: Uint8Array;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, maxBytes) }));
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ZipEntryTooLargeError(entry.path, maxBytes);
      }
      throw new ZipError(`"${entry.path}" can't be read from the zip`);
    }
  } else {
    throw new ZipError(`"${entry.path}" uses a compression the reader doesn't support`);
  }
  if (data.byteLength !== entry.size || crc32(data) >>> 0 !== entry.crc >>> 0) {
    throw new ZipError(`"${entry.path}" is damaged in the zip`);
  }
  return data;
}
