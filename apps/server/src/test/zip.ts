import { crc32, deflateRawSync } from 'node:zlib';

/** One file (or folder, ending in "/") of a zip built for a test. */
export type ZipFile = {
  path: string;
  data?: string | Uint8Array;
  /** "link": a Unix symbolic link to `data`; "store": no compression. */
  kind?: 'file' | 'link' | 'store';
  /** Lies about the inflated size in the headers (a zip bomb's trick). */
  declaredSize?: number;
};

/**
 * A zip archive built by hand, so a test controls every byte: deflated files, stored files,
 * symbolic links (Unix mode in the external attributes) and unsafe paths.
 */
export function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const raw =
      typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : Buffer.from(file.data ?? []);
    const folder = file.path.endsWith('/');
    const store = folder || file.kind === 'link' || file.kind === 'store';
    const body = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    const size = file.declaredSize ?? raw.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, body);
    const mode = file.kind === 'link' ? 0o120777 : folder ? 0o040755 : 0o100644;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.byteLength + body.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
