import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertStorageKey,
  type FileStorage,
  type StoredFileInfo,
  StoredFileNotFoundError,
} from './file-storage.ts';

// The temp file a write goes through before its rename (see `put`).
const TEMP_FILE = /\.[0-9a-f-]{36}\.tmp$/;

/** Stores files under one directory (a Docker volume in production). */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so a reader never sees a half-written file.
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StoredFileNotFoundError(key);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async *list(prefix: string): AsyncIterable<StoredFileInfo> {
    // Walk the deepest directory the prefix names, keeping the keys that match the rest.
    const slash = prefix.lastIndexOf('/');
    const dirKey = slash >= 0 ? prefix.slice(0, slash) : '';
    yield* this.walk(dirKey ? this.pathFor(dirKey) : this.root, dirKey, prefix);
  }

  private async *walk(dir: string, dirKey: string, prefix: string): AsyncIterable<StoredFileInfo> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const key = dirKey ? `${dirKey}/${entry.name}` : entry.name;
      if (!key.startsWith(prefix)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(path, key, prefix);
      } else if (entry.isFile() && !TEMP_FILE.test(entry.name)) {
        try {
          yield { key, lastModified: (await stat(path)).mtime };
        } catch (error) {
          // Deleted since the directory was read.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  private pathFor(key: string): string {
    assertStorageKey(key);
    const path = resolve(this.root, key);
    // Belt and braces: the key check already rules out escaping the root.
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key "${key}"`);
    return path;
  }
}
