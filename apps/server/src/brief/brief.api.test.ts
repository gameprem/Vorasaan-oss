import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  BRIEF_TEMPLATE,
  type BriefDiff,
  type BriefProposalView,
  type BriefVersionView,
  type ProjectBriefView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const brief = `/projects/${SEED.projectId}/brief`;
const versions = `/projects/${SEED.projectId}/brief-versions`;

const V1 = `# Project Brief

## Business goals
Grow mobile payments.

## Target users
Retail customers.
`;
const V2 = `# Project Brief

## Business goals
Grow mobile payments by 20%.

## Target users
Retail customers.

## Non-goals
Business accounts.
`;

describe('Project Brief', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  let asMia: ReturnType<typeof as>;
  let miaId: string;

  /** Beam becomes a PO of the seeded Project's Team, without Admin rights. */
  async function makeBeamPo() {
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
  }

  async function writeTwo(write = asBeam) {
    const v1 = await write<BriefVersionView>('POST', versions, { markdown: V1, baseVersion: 0 });
    expect(v1.status).toBe(201);
    const v2 = await write<BriefVersionView>('POST', versions, {
      markdown: V2,
      summary: 'Target and non-goals',
      baseVersion: 1,
    });
    expect(v2.status).toBe(201);
  }

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
    const mia = await db.user.create({
      data: { email: 'mia@acme.test', name: 'Mia', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: mia.id, role: 'MEMBER' },
    });
    // Mia is in the Team, but not as a PO.
    await db.teamMembership.create({
      data: { teamId: SEED.teamId, userId: mia.id, role: 'BACKEND' },
    });
    miaId = mia.id;
    asMia = as(app, mia.id);
  });

  test('a new Project serves the empty template as v0; only editors see canEdit', async () => {
    const res = await asMia<ProjectBriefView>('GET', brief);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectId: SEED.projectId,
      version: 0,
      markdown: BRIEF_TEMPLATE,
      current: null,
      canEdit: false,
    });
    expect((await asPim<ProjectBriefView>('GET', brief)).body.canEdit).toBe(true);
    expect((await asMia('GET', versions)).body).toEqual([]);

    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asMia('GET', `/projects/${unknown}/brief`)).status).toBe(404);

    const outsider = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    expect((await as(app, outsider.id)('GET', brief)).status).toBe(404);
    expect((await as(app, outsider.id)('GET', versions)).status).toBe(404);
  });

  test('a PO of one of the Project’s Teams edits v1 then v2; a Member gets 403; a stale edit gets 409', async () => {
    await makeBeamPo();
    await writeTwo();

    const current = await asMia<ProjectBriefView>('GET', brief);
    expect(current.body).toMatchObject({
      version: 2,
      markdown: V2,
      current: {
        version: 2,
        source: 'MANUAL',
        summary: 'Target and non-goals',
        approvedBy: { id: beam.id },
        revertedFrom: null,
      },
    });
    const listed = await asMia<BriefVersionView[]>('GET', versions);
    expect(listed.body.map((v) => v.version)).toEqual([2, 1]);
    expect(listed.body[1]?.summary).toBe('Initial Project Brief');

    const member = await asMia('POST', versions, { markdown: '# Mine', baseVersion: 2 });
    expect(member.status).toBe(403);

    const stale = await asBeam('POST', versions, { markdown: '# Late', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await asBeam('POST', versions, { markdown: '# No base' })).status).toBe(400);
    expect((await asBeam('POST', versions, { markdown: '  ', baseVersion: 2 })).status).toBe(400);
    expect(await db.briefVersion.count()).toBe(2);
  });

  test('Admins edit; a PO of another Project’s Team and a Role Owner PO elsewhere do not', async () => {
    const saved = await asPim<BriefVersionView>('POST', versions, { markdown: V1, baseVersion: 0 });
    expect(saved.status).toBe(201);
    expect(saved.body.approvedBy.id).toBe(pim.id);

    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const otherTeam = await db.team.create({ data: { projectId: other.id, name: 'Invest' } });
    await db.teamMembership.create({ data: { teamId: otherTeam.id, userId: miaId, role: 'PO' } });

    expect((await asMia('POST', versions, { markdown: '# Mine', baseVersion: 1 })).status).toBe(
      403,
    );
    expect((await asMia<ProjectBriefView>('GET', brief)).body.canEdit).toBe(false);
    // ...but Mia edits the Brief of the Project whose Team she is a PO of.
    const own = await asMia<BriefVersionView>('POST', `/projects/${other.id}/brief-versions`, {
      markdown: '# Wealth',
      baseVersion: 0,
    });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ projectId: other.id, version: 1 });
    // Versions are numbered per Project.
    expect((await asMia<ProjectBriefView>('GET', brief)).body.version).toBe(1);
  });

  test('revert creates the next version with the old Markdown; the diff lists added and removed lines', async () => {
    await makeBeamPo();
    await writeTwo();

    const reverted = await asBeam<BriefVersionView>('POST', `${versions}/1/revert`, {
      baseVersion: 2,
    });
    expect(reverted.status).toBe(201);
    expect(reverted.body).toMatchObject({
      version: 3,
      markdown: V1,
      source: 'REVERT',
      summary: 'Reverted to v1',
      revertedFrom: 1,
      approvedBy: { id: beam.id },
    });
    expect(await db.briefVersion.count()).toBe(3);

    const diff = await asMia<BriefDiff>(
      'GET',
      `/projects/${SEED.projectId}/brief-diff?from=1&to=2`,
    );
    expect(diff.status).toBe(200);
    expect(diff.body.added).toBe(4);
    expect(diff.body.removed).toBe(1);
    expect(diff.body.lines.filter((l) => l.kind === 'REMOVED').map((l) => l.text)).toEqual([
      'Grow mobile payments.',
    ]);
    expect(diff.body.lines.filter((l) => l.kind === 'ADDED').map((l) => l.text)).toContain(
      'Grow mobile payments by 20%.',
    );

    const fromEmpty = await asMia<BriefDiff>(
      'GET',
      `/projects/${SEED.projectId}/brief-diff?from=0&to=1`,
    );
    expect(fromEmpty.body.removed).toBe(0);
    expect(fromEmpty.body.added).toBe(V1.trimEnd().split('\n').length);
  });

  test('revert guards: stale 409, identical 422, unknown 404, Member 403', async () => {
    await makeBeamPo();
    await writeTwo();

    expect((await asBeam('POST', `${versions}/1/revert`, { baseVersion: 1 })).status).toBe(409);
    expect((await asBeam('POST', `${versions}/2/revert`, { baseVersion: 2 })).status).toBe(422);
    expect((await asBeam('POST', `${versions}/9/revert`, { baseVersion: 2 })).status).toBe(404);
    expect((await asBeam('POST', `${versions}/3000000000/revert`, { baseVersion: 2 })).status).toBe(
      404,
    );
    expect((await asMia('POST', `${versions}/1/revert`, { baseVersion: 2 })).status).toBe(403);
    expect(await db.briefVersion.count()).toBe(2);
  });

  test('one version reads back; unknown versions and Projects are 404', async () => {
    await makeBeamPo();
    await writeTwo();
    const v1 = await asMia<BriefVersionView>('GET', `${versions}/1`);
    expect(v1.body).toMatchObject({ version: 1, markdown: V1, projectId: SEED.projectId });
    expect((await asMia('GET', `${versions}/9`)).status).toBe(404);
    expect((await asMia('GET', `${versions}/abc`)).status).toBe(400);
    expect((await asMia('GET', `${versions}/3000000000`)).status).toBe(404);
    const diff = `/projects/${SEED.projectId}/brief-diff`;
    expect((await asMia('GET', `${diff}?from=1&to=9`)).status).toBe(404);
    expect((await asMia('GET', `${diff}?from=3000000000&to=1`)).status).toBe(404);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asMia('GET', `/projects/${unknown}/brief-versions/1`)).status).toBe(404);
  });

  describe('Brief Proposals', () => {
    async function propose(approverId: string, baseVersionId: string | null, markdown = V1) {
      return db.briefProposal.create({
        data: {
          projectId: SEED.projectId,
          baseVersionId,
          source: 'GRILLING',
          proposedMarkdown: markdown,
          approverId,
        },
      });
    }

    test('the approver approves: the next Brief Version is created and the proposal is APPROVED', async () => {
      await makeBeamPo();
      const proposal = await propose(beam.id, null);

      const read = await asMia<BriefProposalView>('GET', `/brief-proposals/${proposal.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        status: 'PENDING',
        baseVersion: null,
        baseMarkdown: '',
        proposedMarkdown: V1,
        approver: { id: beam.id },
        resultVersion: null,
      });
      const pending = await asMia<BriefProposalView[]>(
        'GET',
        `/projects/${SEED.projectId}/brief-proposals`,
      );
      expect(pending.body.map((p) => p.id)).toEqual([proposal.id]);

      expect((await asPim('POST', `/brief-proposals/${proposal.id}/approve`)).status).toBe(403);
      const approved = await asBeam<BriefVersionView>(
        'POST',
        `/brief-proposals/${proposal.id}/approve`,
      );
      expect(approved.status).toBe(201);
      expect(approved.body).toMatchObject({
        version: 1,
        source: 'GRILLING',
        markdown: V1,
        approvedBy: { id: beam.id },
      });
      const after = await asMia<BriefProposalView>('GET', `/brief-proposals/${proposal.id}`);
      expect(after.body).toMatchObject({ status: 'APPROVED', resultVersion: 1 });
      expect((await asBeam('POST', `/brief-proposals/${proposal.id}/approve`)).status).toBe(409);
      expect((await asBeam('POST', `/brief-proposals/${proposal.id}/reject`)).status).toBe(409);
    });

    test('a proposal drafted on an older Brief gets 409 and writes nothing', async () => {
      await makeBeamPo();
      const proposal = await propose(beam.id, null, V2);
      await asBeam('POST', versions, { markdown: V1, baseVersion: 0 });

      const stale = await asBeam('POST', `/brief-proposals/${proposal.id}/approve`);
      expect(stale.status).toBe(409);
      expect(await db.briefVersion.count()).toBe(1);
      expect(
        (await db.briefProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
      ).toBe('PENDING');

      const v1 = await db.briefVersion.findFirstOrThrow();
      const fresh = await propose(beam.id, v1.id, V2);
      const ok = await asBeam<BriefVersionView>('POST', `/brief-proposals/${fresh.id}/approve`);
      expect(ok.status).toBe(201);
      expect(ok.body.version).toBe(2);
    });

    test('an approver who is no longer an editor cannot approve; reject marks REJECTED', async () => {
      const proposal = await propose(beam.id, null);
      // Beam is not a PO: he cannot approve even though he is the named approver.
      expect((await asBeam('POST', `/brief-proposals/${proposal.id}/approve`)).status).toBe(403);

      await makeBeamPo();
      expect((await asMia('POST', `/brief-proposals/${proposal.id}/reject`)).status).toBe(403);
      const rejected = await asBeam<BriefProposalView>(
        'POST',
        `/brief-proposals/${proposal.id}/reject`,
      );
      expect(rejected.status).toBe(201);
      expect(rejected.body.status).toBe('REJECTED');
      expect(await db.briefVersion.count()).toBe(0);
      expect((await asBeam('POST', `/brief-proposals/${proposal.id}/approve`)).status).toBe(409);

      const unknown = '00000000-0000-4000-8000-0000000000ff';
      expect((await asBeam('GET', `/brief-proposals/${unknown}`)).status).toBe(404);
    });
  });
});
