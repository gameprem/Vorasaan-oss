import { Inject } from '@nestjs/common';

/**
 * Where Attachment bytes live (REQUIREMENT §1 "File storage"). Nothing else
 * touches `fs` or a bucket for Attachments. Keys are chosen by the server,
 * never by the client, and every driver re-checks them with `assertStorageKey`.
 */
export interface FileStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Throws `StoredFileNotFoundError` when nothing is stored under `key`. */
  get(key: string): Promise<Uint8Array>;
  /** Succeeds when nothing is stored under `key`. */
  delete(key: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

// Inject with `@InjectFileStorage() private readonly storage: FileStorage`.
export const InjectFileStorage = () => Inject(FILE_STORAGE);

export class StoredFileNotFoundError extends Error {
  constructor(key: string) {
    super(`No stored file under "${key}"`);
  }
}

// Slash-separated segments of [A-Za-z0-9._-], none of them "." or "..".
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Rejects keys that could escape the storage root (traversal, absolute paths, odd bytes). */
export function assertStorageKey(key: string): void {
  const segments = key.split('/');
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new Error(`Invalid storage key "${key}"`);
}
