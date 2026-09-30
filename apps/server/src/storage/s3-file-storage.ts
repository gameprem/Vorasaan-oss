import { assertStorageKey, type FileStorage, StoredFileNotFoundError } from './file-storage.ts';

export type S3StorageOptions = {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

/** Any S3-compatible bucket (S3, MinIO, R2), through Bun's built-in client. */
export class S3FileStorage implements FileStorage {
  private readonly client: Bun.S3Client;

  constructor(options: S3StorageOptions) {
    this.client = new Bun.S3Client(options);
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.client.write(key, data, { type: contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    assertStorageKey(key);
    try {
      return await this.client.file(key).bytes();
    } catch (error) {
      if (isNotFound(error)) throw new StoredFileNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.delete(key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'NoSuchKey' || code === 'ERR_S3_FILE_NOT_FOUND';
}
