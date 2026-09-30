import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileStorage, StoredFileNotFoundError } from './file-storage.ts';
import { LocalFileStorage } from './local-file-storage.ts';
import { S3FileStorage } from './s3-file-storage.ts';
import { fileStorageFromEnv } from './storage.module.ts';

/** A path-style S3 endpoint in memory: PUT, GET and DELETE on /<bucket>/<key>. Ignores auth. */
function startFakeS3() {
  const objects = new Map<string, { body: Uint8Array; type: string | null }>();
  const notFound = () =>
    new Response('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', {
      status: 404,
      headers: { 'content-type': 'application/xml' },
    });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (req.method === 'PUT') {
        objects.set(path, {
          body: new Uint8Array(await req.arrayBuffer()),
          type: req.headers.get('content-type'),
        });
        return new Response(null, { status: 200, headers: { etag: '"fake"' } });
      }
      const object = objects.get(path);
      if (req.method === 'GET') {
        return object
          ? new Response(object.body, { headers: { 'content-type': object.type ?? '' } })
          : notFound();
      }
      if (req.method === 'DELETE') {
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });
  return { server, objects };
}

const bytes = (text: string) => new TextEncoder().encode(text);

function contract(name: string, make: () => FileStorage) {
  describe(`${name} FileStorage`, () => {
    test('put, get and delete round-trip the exact bytes', async () => {
      const storage = make();
      const data = new Uint8Array([0, 1, 2, 250, 255]);
      await storage.put('attachments/f1/a1', data, 'application/octet-stream');
      expect(await storage.get('attachments/f1/a1')).toEqual(data);

      await storage.put('attachments/f1/a1', bytes('v2'), 'text/plain');
      expect(new TextDecoder().decode(await storage.get('attachments/f1/a1'))).toBe('v2');

      await storage.delete('attachments/f1/a1');
      await expect(storage.get('attachments/f1/a1')).rejects.toBeInstanceOf(
        StoredFileNotFoundError,
      );
      // Deleting twice is fine.
      await storage.delete('attachments/f1/a1');
    });

    test('keys that could escape the root are refused', async () => {
      const storage = make();
      for (const key of ['../x', 'a/../../x', '/etc/passwd', 'a//b', 'a/./b', '', 'a\\b', '.env']) {
        await expect(storage.put(key, bytes('x'), 'text/plain')).rejects.toThrow(
          'Invalid storage key',
        );
        await expect(storage.get(key)).rejects.toThrow('Invalid storage key');
        await expect(storage.delete(key)).rejects.toThrow('Invalid storage key');
      }
    });
  });
}

let dir: string;
let fakeS3: ReturnType<typeof startFakeS3>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vorasaan-storage-'));
  fakeS3 = startFakeS3();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  fakeS3.server.stop(true);
});

contract('local', () => new LocalFileStorage(dir));

contract(
  'S3',
  () =>
    new S3FileStorage({
      bucket: 'vorasaan',
      endpoint: fakeS3.server.url.origin,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    }),
);

describe('storage drivers', () => {
  test('the local driver leaves no temp files behind', async () => {
    const storage = new LocalFileStorage(join(dir, 'clean'));
    await storage.put('a/b', bytes('x'), 'text/plain');
    expect(await readdir(join(dir, 'clean', 'a'))).toEqual(['b']);
  });

  test('the S3 driver stores under the bucket with the content type', async () => {
    const storage = new S3FileStorage({
      bucket: 'vorasaan',
      endpoint: fakeS3.server.url.origin,
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    await storage.put('attachments/f/a.md', bytes('# Hi'), 'text/markdown');
    expect(fakeS3.objects.get('/vorasaan/attachments/f/a.md')?.type).toStartWith('text/markdown');
  });

  test('FILE_STORAGE_DRIVER picks the driver', () => {
    expect(fileStorageFromEnv({})).toBeInstanceOf(LocalFileStorage);
    expect(fileStorageFromEnv({ FILE_STORAGE_DRIVER: 's3', S3_BUCKET: 'b' })).toBeInstanceOf(
      S3FileStorage,
    );
    expect(() => fileStorageFromEnv({ FILE_STORAGE_DRIVER: 's3' })).toThrow('S3_BUCKET');
    expect(() => fileStorageFromEnv({ FILE_STORAGE_DRIVER: 'ftp' })).toThrow('Unknown');
  });
});
