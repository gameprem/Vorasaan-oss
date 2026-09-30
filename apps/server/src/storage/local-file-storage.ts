import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assertStorageKey, type FileStorage, StoredFileNotFoundError } from './file-storage.ts';

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

  private pathFor(key: string): string {
    assertStorageKey(key);
    const path = resolve(this.root, key);
    // Belt and braces: the key check already rules out escaping the root.
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key "${key}"`);
    return path;
  }
}
