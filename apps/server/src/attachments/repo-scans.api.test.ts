import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import { type AttachmentView, REPO_SCAN_MAX_CHARS } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const scansUrl = `/projects/${SEED.projectId}/repo-scans`;
const scan = (markdown = '# Repo Scan: mobile-bank\n\n## Dependencies\n- next\n') => ({
  markdown,
  repoName: 'acme/mobile-bank',
  commitSha: 'a1b2c3d4e5f6',
});

describe('Repo Scans', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  let asMia: ReturnType<typeof as>;
  let miaId: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    // Beam is a Role Owner (BACKEND) of the seeded Feature and a Member of the
    // Organization, not a PO; Mia is only a Member.
    const mia = await db.user.create({
      data: { email: 'mia@acme.test', name: 'Mia', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: mia.id, role: 'MEMBER' },
    });
    miaId = mia.id;
    asMia = as(app, mia.id);
  });

  test('a Repo Scan is stored as a Project Attachment with no file, and indexed', async () => {
    const created = await asBeam<AttachmentView>('POST', scansUrl, scan());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      projectId: SEED.projectId,
      featureId: null,
      source: 'REPO_SCAN',
      title: 'Repo Scan: acme/mobile-bank @ a1b2c3d',
      url: null,
      hasFile: false,
      snapshotText: '# Repo Scan: mobile-bank\n\n## Dependencies\n- next',
      addedBy: { id: beam.id },
    });
    expect(created.body.summary).toContain('Repo Scan: acme/mobile-bank');

    const listed = await asMia<AttachmentView[]>('GET', `/projects/${SEED.projectId}/attachments`);
    expect(listed.body.map((a) => a.id)).toEqual([created.body.id]);

    const row = await db.attachment.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.storageKey).toBeNull();
  });

  test('a new scan replaces the Project’s previous one; other Attachments stay', async () => {
    const first = await asPim<AttachmentView>('POST', scansUrl, scan('# First\n'));
    const url = await db.attachment.create({
      data: {
        projectId: SEED.projectId,
        source: 'URL',
        title: 'Goals',
        url: 'https://example.test',
        addedById: pim.id,
      },
    });
    const second = await asPim<AttachmentView>('POST', scansUrl, scan('# Second\n'));
    expect(second.status).toBe(201);
    const left = await db.attachment.findMany({
      where: { projectId: SEED.projectId },
      orderBy: { createdAt: 'asc' },
    });
    expect(left.map((a) => a.id)).toEqual([url.id, second.body.id]);
    expect(left.some((a) => a.id === first.body.id)).toBe(false);
  });

  test('only Admins, POs of the Project’s Teams and Role Owners in the Project may post', async () => {
    // Admin (Pim) and a Role Owner (Beam) may.
    expect((await asPim('POST', scansUrl, scan())).status).toBe(201);
    expect((await asBeam('POST', scansUrl, scan())).status).toBe(201);

    // A plain Member may not.
    expect((await asMia('POST', scansUrl, scan())).status).toBe(403);

    // A Role Owner of a Feature in another Project may not post to this one.
    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const otherTeam = await db.team.create({ data: { projectId: other.id, name: 'Invest' } });
    const feature = await db.feature.create({
      data: { teamId: otherTeam.id, title: 'Robo advisor' },
    });
    await db.roleOwner.create({ data: { featureId: feature.id, userId: miaId, role: 'QA' } });
    expect((await asMia('POST', scansUrl, scan())).status).toBe(403);
    expect((await asMia('POST', `/projects/${other.id}/repo-scans`, scan())).status).toBe(201);

    // A PO of the Project's Team may.
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: miaId, role: 'PO' } });
    expect((await asMia('POST', scansUrl, scan())).status).toBe(201);

    // Outsiders and unknown Projects.
    const outsider = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    expect((await as(app, outsider.id)('POST', scansUrl, scan())).status).toBe(403);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asPim('POST', `/projects/${unknown}/repo-scans`, scan())).status).toBe(404);
  });

  test('the body is validated and size-capped', async () => {
    expect((await asPim('POST', scansUrl, { ...scan(), markdown: '  ' })).status).toBe(400);
    expect((await asPim('POST', scansUrl, { ...scan(), commitSha: 'not a sha' })).status).toBe(400);
    const huge = 'x'.repeat(REPO_SCAN_MAX_CHARS + 1);
    expect((await asPim('POST', scansUrl, scan(huge))).status).toBe(400);
    const { commitSha: _, ...withoutSha } = scan();
    const created = await asPim<AttachmentView>('POST', scansUrl, withoutSha);
    expect(created.body.title).toBe('Repo Scan: acme/mobile-bank');
  });

  test('refreshing a Repo Scan is refused with a hint to re-run the CLI', async () => {
    const created = await asBeam<AttachmentView>('POST', scansUrl, scan());
    const refreshed = await asPim<{ message: string }>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(refreshed.status).toBe(422);
    expect(refreshed.body.message).toContain('vorasaan scan');
  });
});
