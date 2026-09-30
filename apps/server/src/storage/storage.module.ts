import { Module } from '@nestjs/common';
import { FILE_STORAGE, type FileStorage } from './file-storage.ts';
import { LocalFileStorage } from './local-file-storage.ts';
import { S3FileStorage } from './s3-file-storage.ts';

const DEFAULT_LOCAL_DIR = './data/files';

/** Picks the driver from `FILE_STORAGE_DRIVER` ("local", the default, or "s3"). */
export function fileStorageFromEnv(env: Record<string, string | undefined> = process.env) {
  const driver = env.FILE_STORAGE_DRIVER || 'local';
  if (driver === 'local') {
    return new LocalFileStorage(env.FILE_STORAGE_LOCAL_DIR || DEFAULT_LOCAL_DIR);
  }
  if (driver === 's3') {
    if (!env.S3_BUCKET) throw new Error('FILE_STORAGE_DRIVER=s3 needs S3_BUCKET');
    return new S3FileStorage({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    });
  }
  throw new Error(`Unknown FILE_STORAGE_DRIVER "${driver}": use "local" or "s3"`);
}

@Module({
  providers: [{ provide: FILE_STORAGE, useFactory: (): FileStorage => fileStorageFromEnv() }],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
