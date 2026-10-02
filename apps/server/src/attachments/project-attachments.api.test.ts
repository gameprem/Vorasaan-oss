import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { AttachmentView } from '@vorasaan/shared';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const projectUrl = `/projects/${SEED.projectId}/attachments`;
const featureUrl = `/features/${SEED.featureId}/attachments`;
const bytes = (s: string) => new TextEncoder().encode(s);

/** A one-file multipart body. */
function multipart(filename: string, data: Uint8Array) {
  const boundary = `----vorasaan${crypto.randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return {
    payload: Buffer.concat([bytes(head), data, bytes(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('Project Attachments', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let storageDir: string;
  let page: { html: string };
  let pages: ReturnType<typeof Bun.serve>;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  let asMia: ReturnType<typeof as>;
  let miaId: string;

  async function upload(userId: string, filename: string, text: string, url = projectUrl) {
    const body = multipart(filename, bytes(text));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...body.headers, [DEV_USER_HEADER]: userId },
      payload: body.payload,
    });
    return { status: res.statusCode, body: res.json() as AttachmentView };
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'vorasaan-project-attachments-'));
    process.env.FILE_STORAGE_DRIVER = 'local';
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir;
    process.env.ATTACHMENT_ALLOW_PRIVATE_URLS = 'true';
    pages = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(page.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    ({ app } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    delete process.env.ATTACHMENT_ALLOW_PRIVATE_URLS;
    pages.stop(true);
    await db.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    await rm(join(storageDir, 'attachments'), { recursive: true, force: true });
    page = {
      html: '<html><head><title>Company goals</title></head><body><main><p>Grow.</p></main></body></html>',
    };
    // Beam is a PO of the Project's Team; Mia is only a Member of the Organization.
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
    const mia = await db.user.create({
      data: { email: 'mia@acme.test', name: 'Mia', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: mia.id, role: 'MEMBER' },
    });
    miaId = mia.id;
    asMia = as(app, mia.id);
  });

  test('a Project Attachment snapshots like a Feature Attachment, stored under the Project', async () => {
    const markdown = '# Company handbook\n\nWe ship to retail customers first.\n';
    const created = await upload(beam.id, 'handbook.md', markdown);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      featureId: null,
      projectId: SEED.projectId,
      source: 'FILE',
      title: 'handbook.md',
      mimeType: 'text/markdown',
      hasFile: true,
      snapshotText: markdown,
      summary: 'Summary of "handbook.md": # Company handbook',
      addedBy: { id: beam.id },
    });
    expect(await readdir(join(storageDir, 'attachments', 'projects', SEED.projectId))).toEqual([
      created.body.id,
    ]);

    const file = await app.inject({
      method: 'GET',
      url: `/attachments/${created.body.id}/file`,
      headers: { [DEV_USER_HEADER]: beam.id },
    });
    expect(file.rawPayload).toEqual(Buffer.from(markdown));

    const url = `${pages.url.origin}/goals`;
    const linked = await asBeam<AttachmentView>('POST', projectUrl, { url });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      projectId: SEED.projectId,
      featureId: null,
      title: 'Company goals',
      snapshotText: 'Grow.',
    });
    page.html = '<html><body><main><p>Grow faster.</p></main></body></html>';
    const refreshed = await asPim<AttachmentView>('POST', `/attachments/${linked.body.id}/refresh`);
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.snapshotText).toBe('Grow faster.');

    // The Organization reads it; the Feature's list and the Project's list stay apart.
    const listed = await asMia<AttachmentView[]>('GET', projectUrl);
    expect(listed.body.map((a) => a.id)).toEqual([created.body.id, linked.body.id]);
    const byPim = await upload(pim.id, 'feature.md', '# Feature only\n', featureUrl);
    expect(byPim.body).toMatchObject({ featureId: SEED.featureId, projectId: null });
    expect((await asMia<AttachmentView[]>('GET', featureUrl)).body.map((a) => a.id)).toEqual([
      byPim.body.id,
    ]);
    expect((await asMia<AttachmentView[]>('GET', projectUrl)).body).toHaveLength(2);
  });

  test('permissions follow the Brief’s: editors add, refresh and remove; the Organization reads', async () => {
    const created = await upload(beam.id, 'handbook.md', '# Handbook\n');
    const id = created.body.id;

    // A Member reads but cannot change anything.
    expect((await asMia('GET', projectUrl)).status).toBe(200);
    expect((await upload(miaId, 'x.md', '# X\n')).status).toBe(403);
    expect((await asMia('POST', projectUrl, { url: `${pages.url.origin}/x` })).status).toBe(403);
    expect((await asMia('POST', `/attachments/${id}/refresh`)).status).toBe(403);
    expect((await asMia('DELETE', `/attachments/${id}`)).status).toBe(403);

    // A PO of another Project's Team is a Member here.
    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const otherTeam = await db.team.create({ data: { projectId: other.id, name: 'Invest' } });
    await db.teamMembership.create({
      data: { teamId: otherTeam.id, userId: miaId, role: 'PO' },
    });
    expect((await asMia('DELETE', `/attachments/${id}`)).status).toBe(403);
    expect(
      (await asMia('POST', `/projects/${other.id}/attachments`, { url: `${pages.url.origin}/w` }))
        .status,
    ).toBe(201);

    // Someone outside the Organization cannot even read.
    const outsider = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    const asOutsider = as(app, outsider.id);
    expect((await asOutsider('GET', projectUrl)).status).toBe(403);
    const download = await app.inject({
      method: 'GET',
      url: `/attachments/${id}/file`,
      headers: { [DEV_USER_HEADER]: outsider.id },
    });
    expect(download.statusCode).toBe(403);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asPim('GET', `/projects/${unknown}/attachments`)).status).toBe(404);

    // An Admin removes it; the stored file goes too.
    expect((await asPim('DELETE', `/attachments/${id}`)).status).toBe(204);
    expect(await db.attachment.count({ where: { id } })).toBe(0);
    expect(await readdir(join(storageDir, 'attachments', 'projects', SEED.projectId))).toEqual([]);
  });
});
