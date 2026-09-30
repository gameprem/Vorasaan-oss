import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import type { SpecDiff, SpecVersionView } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const versions = `/features/${SEED.featureId}/spec-versions`;

describe('Spec editing, diff and revert', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  /** Pim (Admin and PO) writes v2 and v3 on top of the seeded v1. */
  async function writeTwoMore() {
    const v2 = await asPim<SpecVersionView>('POST', versions, {
      markdown: `${SEED_SPEC_V1}\n## Notes\nPoll the provider every 5 seconds.\n`,
      summary: 'Polling interval',
      baseVersion: 1,
    });
    expect(v2.status).toBe(201);
    const v3 = await asPim<SpecVersionView>('POST', versions, {
      markdown: SEED_SPEC_V1.replace('Refund flows.', 'Refund flows and chargebacks.'),
      baseVersion: 2,
    });
    expect(v3.status).toBe(201);
  }

  /** Makes Beam a PO Role Owner of the seeded Feature, without Admin rights. */
  async function makeBeamPo() {
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
    await db.roleOwner.create({ data: { featureId: SEED.featureId, userId: beam.id, role: 'PO' } });
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
  });

  test('a manual edit stores its summary; a stale edit gets 409; a non-PO gets 403', async () => {
    const saved = await asPim<SpecVersionView>('POST', versions, {
      markdown: '# Async checkout\n\nShorter.',
      summary: 'Trimmed the Spec',
      baseVersion: 1,
    });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      version: 2,
      source: 'MANUAL',
      summary: 'Trimmed the Spec',
      revertedFrom: null,
      approvedBy: { id: pim.id },
    });

    const stale = await asPim('POST', versions, { markdown: '# Other', baseVersion: 1 });
    expect(stale.status).toBe(409);

    const missingBase = await asPim('POST', versions, { markdown: '# Other' });
    expect(missingBase.status).toBe(400);

    const nonPo = await asBeam('POST', versions, { markdown: '# Mine', baseVersion: 2 });
    expect(nonPo.status).toBe(403);
    expect(await db.specVersion.count({ where: { featureId: SEED.featureId } })).toBe(2);
  });

  test('a PO Role Owner who is not an Admin can edit', async () => {
    await makeBeamPo();
    const saved = await asBeam<SpecVersionView>('POST', versions, {
      markdown: '# Mine',
      baseVersion: 1,
    });
    expect(saved.status).toBe(201);
    expect(saved.body.approvedBy.id).toBe(beam.id);
  });

  test('one version’s Markdown can be read back', async () => {
    await writeTwoMore();
    const v1 = await asBeam<SpecVersionView>('GET', `${versions}/1`);
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ version: 1, markdown: SEED_SPEC_V1 });

    expect((await asBeam('GET', `${versions}/9`)).status).toBe(404);
    expect((await asBeam('GET', `${versions}/abc`)).status).toBe(400);
    const otherFeature = '00000000-0000-4000-8000-0000000000ff';
    expect((await asBeam('GET', `/features/${otherFeature}/spec-versions/1`)).status).toBe(404);
  });

  test('revert to v1 from v3 creates v4 with v1’s Markdown and never deletes versions', async () => {
    await writeTwoMore();
    const v1 = await db.specVersion.findUniqueOrThrow({
      where: { featureId_version: { featureId: SEED.featureId, version: 1 } },
    });

    const reverted = await asPim<SpecVersionView>('POST', `${versions}/1/revert`, {
      baseVersion: 3,
    });
    expect(reverted.status).toBe(201);
    expect(reverted.body).toMatchObject({
      version: 4,
      markdown: SEED_SPEC_V1,
      source: 'REVERT',
      summary: 'Reverted to v1',
      revertedFrom: 1,
      approvedBy: { id: pim.id },
    });
    const stored = await db.specVersion.findUniqueOrThrow({ where: { id: reverted.body.id } });
    expect(stored.revertedFromId).toBe(v1.id);

    const list = await asBeam<SpecVersionView[]>('GET', versions);
    expect(list.body.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(list.body[0]?.revertedFrom).toBe(1);
  });

  test('revert is guarded: non-PO 403, stale 409, no-op 422, unknown version 404', async () => {
    await writeTwoMore();
    expect((await asBeam('POST', `${versions}/1/revert`, { baseVersion: 3 })).status).toBe(403);
    expect((await asPim('POST', `${versions}/1/revert`, { baseVersion: 2 })).status).toBe(409);
    expect((await asPim('POST', `${versions}/3/revert`, { baseVersion: 3 })).status).toBe(422);
    expect((await asPim('POST', `${versions}/7/revert`, { baseVersion: 3 })).status).toBe(404);
    expect((await asPim('POST', `${versions}/1/revert`, {})).status).toBe(400);
    expect(await db.specVersion.count({ where: { featureId: SEED.featureId } })).toBe(3);

    await makeBeamPo();
    const byPo = await asBeam<SpecVersionView>('POST', `${versions}/2/revert`, {
      baseVersion: 3,
      summary: 'Back to polling notes',
    });
    expect(byPo.status).toBe(201);
    expect(byPo.body).toMatchObject({ version: 4, summary: 'Back to polling notes' });
  });

  test('the diff of two versions lists added and removed lines', async () => {
    await writeTwoMore();
    const diff = await asBeam<SpecDiff>('GET', `/features/${SEED.featureId}/spec-diff?from=2&to=3`);
    expect(diff.status).toBe(200);
    expect(diff.body.from).toBe(2);
    expect(diff.body.to).toBe(3);

    const changed = diff.body.lines.filter((l) => l.kind !== 'UNCHANGED');
    expect(changed).toEqual([
      { kind: 'REMOVED', text: '- Refund flows.', fromLine: expect.any(Number), toLine: null },
      {
        kind: 'ADDED',
        text: '- Refund flows and chargebacks.',
        fromLine: null,
        toLine: expect.any(Number),
      },
      { kind: 'REMOVED', text: '', fromLine: expect.any(Number), toLine: null },
      { kind: 'REMOVED', text: '## Notes', fromLine: expect.any(Number), toLine: null },
      {
        kind: 'REMOVED',
        text: 'Poll the provider every 5 seconds.',
        fromLine: expect.any(Number),
        toLine: null,
      },
    ]);
    expect(diff.body).toMatchObject({ added: 1, removed: 4 });
    // Every line of both versions appears exactly once.
    const v3Lines = SEED_SPEC_V1.trimEnd().split('\n').length;
    expect(diff.body.lines.filter((l) => l.toLine !== null)).toHaveLength(v3Lines);
  });

  test('from=0 diffs against an empty Spec; bad or unknown versions are rejected', async () => {
    const url = `/features/${SEED.featureId}/spec-diff`;
    const first = await asBeam<SpecDiff>('GET', `${url}?from=0&to=1`);
    expect(first.status).toBe(200);
    expect(first.body.removed).toBe(0);
    expect(first.body.lines.every((l) => l.kind === 'ADDED')).toBe(true);

    const same = await asBeam<SpecDiff>('GET', `${url}?from=1&to=1`);
    expect(same.body).toMatchObject({ added: 0, removed: 0 });

    expect((await asBeam('GET', `${url}?from=1&to=5`)).status).toBe(404);
    expect((await asBeam('GET', `${url}?from=1`)).status).toBe(400);
    expect((await asBeam('GET', `${url}?from=x&to=1`)).status).toBe(400);
    expect((await asBeam('GET', `${url}?from=0&to=0`)).status).toBe(400);
    expect((await asBeam('GET', `${url}?from=&to=1`)).status).toBe(400);
  });
});
