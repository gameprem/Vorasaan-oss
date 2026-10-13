import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { AttachmentFileSweepResult, AttachmentView } from '@vorasaan/shared';
import { AiOutputError } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { makePdf } from '../test/pdf.ts';
import { AttachmentFilesService, ORPHAN_GRACE_MS } from './attachment-files.service.ts';
import { TRUNCATION_MARKER } from './snapshot-text.ts';

const { pim, beam } = SEED.users;
const featureUrl = `/features/${SEED.featureId}/attachments`;

type Part = { name: string; value: string } | { name: string; filename: string; data: Uint8Array };

/** A multipart/form-data body, built by hand so the bytes on the wire are exact. */
function multipart(parts: Part[]) {
  const boundary = `----vorasaan${crypto.randomUUID()}`;
  const chunks: Uint8Array[] = [];
  const text = (s: string) => chunks.push(new TextEncoder().encode(s));
  for (const part of parts) {
    text(`--${boundary}\r\n`);
    if ('data' in part) {
      text(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      );
      chunks.push(part.data);
      text('\r\n');
    } else {
      text(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`);
    }
  }
  text(`--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('Attachments API', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let storageDir: string;
  let page: { html: string; status: number };
  let pages: ReturnType<typeof Bun.serve>;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  async function upload(userId: string, parts: Part[], url = featureUrl) {
    const body = multipart(parts);
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...body.headers, [DEV_USER_HEADER]: userId },
      payload: body.payload,
    });
    return { status: res.statusCode, body: res.json() as AttachmentView };
  }

  async function download(userId: string, id: string) {
    return app.inject({
      method: 'GET',
      url: `/attachments/${id}/file`,
      headers: { [DEV_USER_HEADER]: userId },
    });
  }

  /** Files currently in the local storage directory for the seeded Feature. */
  async function storedFiles() {
    return readdir(join(storageDir, 'attachments', SEED.featureId)).catch(() => []);
  }

  async function createUser(name: string, orgRole?: 'ADMIN' | 'MEMBER') {
    const user = await db.user.create({
      data: { email: `${name}@acme.test`, name, passwordHash: 'x' },
    });
    if (orgRole) {
      await db.orgMembership.create({
        data: { organizationId: SEED.organizationId, userId: user.id, role: orgRole },
      });
    }
    return user;
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'vorasaan-attachments-'));
    process.env.FILE_STORAGE_DRIVER = 'local';
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir;
    // The test page server listens on 127.0.0.1.
    process.env.ATTACHMENT_ALLOW_PRIVATE_URLS = 'true';
    pages = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new URL(req.url).pathname === '/spec'
          ? new Response(page.html, {
              status: page.status,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          : new Response('gone', { status: 404 }),
    });
    ({ app, ai } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    delete process.env.ATTACHMENT_ALLOW_PRIVATE_URLS;
    delete process.env.ATTACHMENT_MAX_BYTES;
    delete process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS;
    pages.stop(true);
    await db.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    await rm(join(storageDir, 'attachments'), { recursive: true, force: true });
    delete process.env.ATTACHMENT_MAX_BYTES;
    delete process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS;
    page = {
      html: `<html><head><title>Provider API</title><script>var secret = 1;</script></head>
        <body><nav>Home | Docs</nav><main><h1>Webhooks</h1><p>Not supported, poll instead.</p></main></body></html>`,
      status: 200,
    };
  });

  test('upload Markdown → Snapshot equals its text; download returns the same bytes', async () => {
    const markdown = '# Checkout notes\n\n- Polling every *30 s*\n- ünïcode — fine\n';
    const created = await upload(beam.id, [
      { name: 'file', filename: 'notes.md', data: bytes(markdown) },
    ]);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      featureId: SEED.featureId,
      source: 'FILE',
      title: 'notes.md',
      url: null,
      mimeType: 'text/markdown',
      hasFile: true,
      snapshotText: markdown,
      addedBy: { id: beam.id, name: 'Beam' },
    });
    expect(created.body.snapshotAt).not.toBeNull();
    expect(await storedFiles()).toEqual([created.body.id]);

    const file = await download(pim.id, created.body.id);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload).toEqual(Buffer.from(markdown));
    expect(file.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(file.headers['content-disposition']).toBe("attachment; filename*=UTF-8''notes.md");
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const list = await asPim<AttachmentView[]>('GET', featureUrl);
    expect(list.status).toBe(200);
    expect(list.body.map((a) => a.id)).toEqual([created.body.id]);
  });

  test('a title field and a UTF-8 file name are kept', async () => {
    const titled = await upload(beam.id, [
      { name: 'title', value: 'Provider contract' },
      { name: 'file', filename: 'c.txt', data: bytes('plain') },
    ]);
    expect(titled.status).toBe(201);
    expect(titled.body.title).toBe('Provider contract');

    const thai = await upload(beam.id, [{ name: 'file', filename: 'สเปก.md', data: bytes('x') }]);
    expect(thai.body.title).toBe('สเปก.md');
  });

  test('a PDF snapshots its text; an image has no text and is served inline', async () => {
    const pdf = await upload(pim.id, [
      { name: 'file', filename: 'brief.pdf', data: makePdf('Refunds are out of scope') },
    ]);
    expect(pdf.status).toBe(201);
    expect(pdf.body.mimeType).toBe('application/pdf');
    expect(pdf.body.snapshotText).toBe('Refunds are out of scope');

    const image = await upload(pim.id, [{ name: 'file', filename: 'flow.png', data: PNG }]);
    expect(image.status).toBe(201);
    expect(image.body.snapshotText).toBeNull();
    expect(image.body.snapshotAt).not.toBeNull();
    const file = await download(beam.id, image.body.id);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toStartWith('inline;');
    expect(file.rawPayload).toEqual(Buffer.from(PNG));
  });

  test('oversized files are rejected with 413 and nothing is stored', async () => {
    process.env.ATTACHMENT_MAX_BYTES = '1000';
    const ok = await upload(beam.id, [
      { name: 'file', filename: 'a.md', data: bytes('x'.repeat(1000)) },
    ]);
    expect(ok.status).toBe(201);

    const big = await upload(beam.id, [
      { name: 'file', filename: 'b.md', data: bytes('x'.repeat(1001)) },
    ]);
    expect(big.status).toBe(413);
    const huge = await upload(beam.id, [
      { name: 'file', filename: 'c.md', data: new Uint8Array(200_000).fill(120) },
    ]);
    expect(huge.status).toBe(413);

    const list = await asBeam<AttachmentView[]>('GET', featureUrl);
    expect(list.body).toHaveLength(1);
    expect(await storedFiles()).toEqual([ok.body.id]);
  });

  test('disallowed or disguised types are rejected, and nothing is stored', async () => {
    const cases: [string, Uint8Array, number][] = [
      ['run.exe', bytes('MZ'), 415],
      ['page.html', bytes('<script>alert(1)</script>'), 415],
      ['logo.svg', bytes('<svg/>'), 415],
      ['README', bytes('no extension'), 415],
      ['fake.pdf', bytes('just text'), 415],
      ['fake.png', bytes('just text'), 415],
      ['binary.md', new Uint8Array([0xff, 0xfe, 0xfd]), 422],
      ['empty.md', new Uint8Array(), 422],
    ];
    for (const [filename, data, status] of cases) {
      const res = await upload(beam.id, [{ name: 'file', filename, data }]);
      expect({ filename, status: res.status }).toEqual({ filename, status });
    }
    const noFile = await upload(beam.id, [{ name: 'title', value: 'nothing' }]);
    expect(noFile.status).toBe(400);
    const wrongField = await upload(beam.id, [{ name: 'doc', filename: 'a.md', data: bytes('x') }]);
    expect(wrongField.status).toBe(400);

    expect((await asBeam<AttachmentView[]>('GET', featureUrl)).body).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  test('a long Snapshot is capped; refreshing a file re-reads it', async () => {
    const created = await upload(beam.id, [
      { name: 'file', filename: 'long.txt', data: bytes('y'.repeat(100)) },
    ]);
    expect(created.body.snapshotText).toBe('y'.repeat(100));

    process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS = '10';
    const refreshed = await asBeam<AttachmentView>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.snapshotText).toBe('y'.repeat(10) + TRUNCATION_MARKER);
    expect(Date.parse(refreshed.body.snapshotAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(created.body.snapshotAt ?? ''),
    );
  });

  test('a URL Attachment snapshots readable text; refresh picks up a change', async () => {
    const url = `${pages.url.origin}/spec`;
    const created = await asBeam<AttachmentView>('POST', featureUrl, { url });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: 'URL',
      title: 'Provider API',
      url,
      mimeType: 'text/html',
      hasFile: false,
      snapshotText: '# Webhooks\n\nNot supported, poll instead.',
    });

    page.html = '<html><body><main><p>Webhooks are now supported.</p></main></body></html>';
    await Bun.sleep(5);
    const refreshed = await asPim<AttachmentView>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.snapshotText).toBe('Webhooks are now supported.');
    expect(Date.parse(refreshed.body.snapshotAt ?? '')).toBeGreaterThan(
      Date.parse(created.body.snapshotAt ?? ''),
    );
    expect(refreshed.body.title).toBe('Provider API');

    // A failed refresh keeps the last good Snapshot.
    page.status = 500;
    const failed = await asPim<{ message: string }>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(failed.status).toBe(422);
    expect(failed.body.message).toContain('HTTP 500');
    const [kept] = (await asPim<AttachmentView[]>('GET', featureUrl)).body;
    expect(kept?.snapshotText).toBe('Webhooks are now supported.');

    const noFile = await download(pim.id, created.body.id);
    expect(noFile.statusCode).toBe(404);
  });

  test('the AI summarizes each Snapshot; a failed summary leaves it null but keeps the Attachment', async () => {
    const created = await asBeam<AttachmentView>('POST', featureUrl, {
      url: `${pages.url.origin}/spec`,
    });
    expect(created.status).toBe(201);
    expect(created.body.summary).toBe('Summary of "Provider API": # Webhooks');

    const image = await upload(pim.id, [{ name: 'file', filename: 'flow.png', data: PNG }]);
    expect(image.body.summary).toBeNull();
    expect(ai.calls.filter((c) => c.method === 'summarizeAttachment')).toHaveLength(1);

    const original = ai.summarizeAttachment.bind(ai);
    ai.summarizeAttachment = async () => {
      throw new AiOutputError('summarize-attachment', new Error('bad output'));
    };
    try {
      const failed = await upload(beam.id, [
        { name: 'file', filename: 'notes.md', data: bytes('Retry must be one tap.') },
      ]);
      expect(failed.status).toBe(201);
      expect(failed.body.snapshotText).toBe('Retry must be one tap.');
      expect(failed.body.summary).toBeNull();

      // A refresh whose summary fails clears the old one rather than keep a stale summary.
      page.html = '<html><body><main><p>Webhooks are now supported.</p></main></body></html>';
      const refreshed = await asBeam<AttachmentView>(
        'POST',
        `/attachments/${created.body.id}/refresh`,
      );
      expect(refreshed.status).toBe(201);
      expect(refreshed.body.summary).toBeNull();
    } finally {
      ai.summarizeAttachment = original;
    }

    const again = await asBeam<AttachmentView>('POST', `/attachments/${created.body.id}/refresh`);
    expect(again.body.summary).toBe('Summary of "Provider API": Webhooks are now supported.');
  });

  test('URL Attachments: a given title wins; bad or unreachable URLs are refused', async () => {
    const titled = await asBeam<AttachmentView>('POST', featureUrl, {
      url: `${pages.url.origin}/spec`,
      title: 'Provider docs',
    });
    expect(titled.body.title).toBe('Provider docs');

    expect((await asBeam('POST', featureUrl, { url: 'not a url' })).status).toBe(400);
    expect((await asBeam('POST', featureUrl, { url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await asBeam('POST', featureUrl, {})).status).toBe(400);
    expect((await asBeam('POST', featureUrl, { url: `${pages.url.origin}/missing` })).status).toBe(
      422,
    );

    // Private addresses are refused unless the operator allows them.
    process.env.ATTACHMENT_ALLOW_PRIVATE_URLS = 'false';
    try {
      const refused = await asBeam<{ message: string }>('POST', featureUrl, {
        url: `${pages.url.origin}/spec`,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.message).toContain('not a public address');
    } finally {
      process.env.ATTACHMENT_ALLOW_PRIVATE_URLS = 'true';
    }
  });

  test('Role Owners and Admins add and remove; the Organization reads; others are refused', async () => {
    const member = await createUser('mai', 'MEMBER');
    const admin = await createUser('ann', 'ADMIN');
    const stranger = await createUser('sam');
    const asMember = as(app, member.id);

    const created = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
    const id = created.body.id;

    // Any Organization member reads.
    expect((await asMember('GET', featureUrl)).status).toBe(200);
    expect((await download(member.id, id)).statusCode).toBe(200);
    // Someone outside the Organization does not.
    expect((await as(app, stranger.id)('GET', featureUrl)).status).toBe(404);
    expect((await download(stranger.id, id)).statusCode).toBe(404);

    // A member who is not a Role Owner can't add, refresh or remove.
    expect(
      (await upload(member.id, [{ name: 'file', filename: 'b.md', data: bytes('b') }])).status,
    ).toBe(403);
    expect((await asMember('POST', featureUrl, { url: `${pages.url.origin}/spec` })).status).toBe(
      403,
    );
    expect((await asMember('POST', `/attachments/${id}/refresh`)).status).toBe(403);
    expect((await asMember('DELETE', `/attachments/${id}`)).status).toBe(403);

    // An Admin can, without owning a role on the Feature.
    expect(
      (await upload(admin.id, [{ name: 'file', filename: 'c.md', data: bytes('c') }])).status,
    ).toBe(201);
    expect((await as(app, admin.id)('DELETE', `/attachments/${id}`)).status).toBe(204);

    // Unknown ids are 404.
    const unknown = '00000000-0000-4000-8000-00000000ffff';
    expect((await asBeam('GET', `/features/${unknown}/attachments`)).status).toBe(404);
    expect(
      (await asBeam('POST', `/features/${unknown}/attachments`, { url: 'https://x.test' })).status,
    ).toBe(404);
    expect((await asBeam('DELETE', `/attachments/${unknown}`)).status).toBe(404);
    expect((await asBeam('GET', '/features/not-a-uuid/attachments')).status).toBe(400);
  });

  test('delete removes the row and the stored file', async () => {
    const created = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
    expect(await storedFiles()).toEqual([created.body.id]);

    const deleted = await asBeam('DELETE', `/attachments/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(await storedFiles()).toEqual([]);
    expect((await download(beam.id, created.body.id)).statusCode).toBe(404);
    expect((await asBeam<AttachmentView[]>('GET', featureUrl)).body).toEqual([]);
  });

  describe('no orphaned files', () => {
    const projectUrl = `/projects/${SEED.projectId}/attachments`;
    const projectFiles = () =>
      readdir(join(storageDir, 'attachments', 'projects', SEED.projectId)).catch(() => []);
    const storage = () => app.get<FileStorage>(FILE_STORAGE);
    const sweep = (userId: string) =>
      as(app, userId)<AttachmentFileSweepResult>('POST', '/attachments/sweep-orphaned-files');

    /** Backdates a stored file so the sweep no longer treats it as a fresh upload. */
    async function age(key: string, ms = ORPHAN_GRACE_MS + 60_000) {
      const then = new Date(Date.now() - ms);
      await utimes(join(storageDir, key), then, then);
    }

    test('deleting a Feature deletes its Attachment files, and only those', async () => {
      const file = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
      const projectFile = await upload(
        pim.id,
        [{ name: 'file', filename: 'p.md', data: bytes('p') }],
        projectUrl,
      );
      expect(file.status).toBe(201);
      expect(projectFile.status).toBe(201);
      expect(await storedFiles()).toEqual([file.body.id]);

      await app.get(AttachmentFilesService).deleteFeature(SEED.featureId);

      expect(await db.feature.findUnique({ where: { id: SEED.featureId } })).toBeNull();
      expect(await db.attachment.findUnique({ where: { id: file.body.id } })).toBeNull();
      expect(await storedFiles()).toEqual([]);
      expect(await projectFiles()).toEqual([projectFile.body.id]);
    });

    test('deleting a Project deletes its own and its Features’ Attachment files', async () => {
      const file = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
      const projectFile = await upload(
        pim.id,
        [{ name: 'file', filename: 'p.md', data: bytes('p') }],
        projectUrl,
      );
      expect(await storedFiles()).toEqual([file.body.id]);
      expect(await projectFiles()).toEqual([projectFile.body.id]);

      await app.get(AttachmentFilesService).deleteProject(SEED.projectId);

      expect(await db.project.findUnique({ where: { id: SEED.projectId } })).toBeNull();
      expect(await storedFiles()).toEqual([]);
      expect(await projectFiles()).toEqual([]);
    });

    test('files are kept when the database delete fails', async () => {
      const file = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
      const unknown = '00000000-0000-4000-8000-00000000ffff';
      await expect(app.get(AttachmentFilesService).deleteFeature(unknown)).rejects.toThrow();
      expect(await storedFiles()).toEqual([file.body.id]);
    });

    test('the sweep removes a planted orphan and leaves live files alone', async () => {
      const live = await upload(beam.id, [{ name: 'file', filename: 'a.md', data: bytes('a') }]);
      const liveProject = await upload(
        pim.id,
        [{ name: 'file', filename: 'p.md', data: bytes('p') }],
        projectUrl,
      );
      const orphan = `attachments/${SEED.featureId}/${crypto.randomUUID()}`;
      const projectOrphan = `attachments/projects/${SEED.projectId}/${crypto.randomUUID()}`;
      // An upload in progress: its file is stored before its Attachment row is created.
      const fresh = `attachments/${SEED.featureId}/${crypto.randomUUID()}`;
      for (const key of [orphan, projectOrphan, fresh]) {
        await storage().put(key, bytes('orphan'), 'text/plain');
      }
      for (const key of [
        orphan,
        projectOrphan,
        `attachments/${SEED.featureId}/${live.body.id}`,
        `attachments/projects/${SEED.projectId}/${liveProject.body.id}`,
      ]) {
        await age(key);
      }

      expect((await sweep(beam.id)).status).toBe(403);

      const swept = await sweep(pim.id);
      expect(swept.status).toBe(200);
      expect(swept.body).toEqual({ checked: 5, removed: 2 });
      expect((await storedFiles()).sort()).toEqual(
        [live.body.id, fresh.split('/').at(-1) as string].sort(),
      );
      expect(await projectFiles()).toEqual([liveProject.body.id]);
      expect((await download(beam.id, live.body.id)).statusCode).toBe(200);

      // Nothing left to remove the second time.
      expect((await sweep(pim.id)).body).toEqual({ checked: 3, removed: 0 });
    });
  });
});
