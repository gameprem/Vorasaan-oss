import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';
import { createTestPrisma, prepareTestDatabase, truncateAll } from '../test/database.ts';
import {
  countLargeOrganization,
  fingerprintLargeOrganization,
  LARGE_ORG_EMBEDDINGS,
  LARGE_ORG_SCALES,
  type LargeOrgResult,
  seedLargeOrganization,
} from './large-organization.ts';

const scale = LARGE_ORG_SCALES.small;

describe('The large Organization seed (ticket 0073), at its small scale', () => {
  let db: PrismaClient;
  let first: LargeOrgResult;
  let firstFingerprint: string;

  beforeAll(async () => {
    process.env.VORASAAN_SECRET_KEY ||= 'test-secret-key-for-vorasaan-tests';
    await prepareTestDatabase();
    db = createTestPrisma();
    await truncateAll(db);
    first = await seedLargeOrganization(db, { scale });
    firstFingerprint = await fingerprintLargeOrganization(db);
  }, 60_000);

  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
  });

  test('builds the counts the scale asks for', () => {
    const features = scale.projects * scale.featuresPerProject;
    const { counts } = first;
    expect(counts.users).toBe(scale.users);
    expect(counts.projects).toBe(scale.projects);
    expect(counts.teams).toBe(scale.projects);
    expect(counts.features).toBe(features);
    expect(counts.decisionRequests).toBe(features * scale.requestsPerFeature);
    expect(counts.chunks).toBe(scale.chunks);
    // A Decision for every decided request, and a Spec Version for each approved proposal.
    const { DECIDED, SPEC_UPDATED } = counts.requestsByStatus;
    expect(counts.decisions).toBe(DECIDED + SPEC_UPDATED);
    expect(counts.specVersions).toBe(features + SPEC_UPDATED);
    expect(counts.briefVersions).toBe(scale.projects);
  });

  test('has every Decision Request state, with Redrafts, Delegations and escalations', async () => {
    const perFeature = await db.decisionRequest.groupBy({
      by: ['featureId', 'status'],
      _count: true,
    });
    expect(perFeature).toHaveLength(scale.projects * scale.featuresPerProject * 6);
    const { counts } = first;
    for (const n of Object.values(counts.requestsByStatus)) expect(n).toBeGreaterThan(0);
    expect(counts.redrafts).toBeGreaterThan(0);
    expect(counts.delegations).toBeGreaterThan(0);
    expect(counts.historyEntries).toBeGreaterThan(0);
    expect(counts.deciderChanges).toBeGreaterThan(0);
    expect(counts.requestMessages).toBeGreaterThan(0);
    // Some requests were sent to a Delegate, and some got one added at escalation step 2.
    expect(
      await db.requestRecipient.count({ where: { onBehalfOfId: { not: null } } }),
    ).toBeGreaterThan(0);
    // Overdue OPEN requests the escalation job still has steps to take for.
    expect(
      await db.decisionRequest.count({
        where: { status: 'OPEN', dueAt: { not: null }, escalationStep: { lt: 3 } },
      }),
    ).toBeGreaterThan(0);
    // Pim decides for every Team, so her Inbox is the heaviest.
    expect(
      await db.decisionRequest.count({
        where: { status: 'OPEN', recipients: { some: { userId: SEED.users.pim.id } } },
      }),
    ).toBeGreaterThan(0);
  });

  test('embeds every chunk and builds the HNSW index for its dimension', async () => {
    const [row] = await db.$queryRaw<{ embedded: bigint; indexes: bigint }[]>`
      SELECT
        (SELECT count(*) FROM "ContentChunk"
          WHERE "embeddingDims" = ${LARGE_ORG_EMBEDDINGS.dims}
            AND "embeddingModel" = ${LARGE_ORG_EMBEDDINGS.model}) AS embedded,
        (SELECT count(*) FROM pg_indexes
          WHERE indexname = ${`ContentChunk_embedding_hnsw_${LARGE_ORG_EMBEDDINGS.dims}`}) AS indexes`;
    expect(Number(row?.embedded)).toBe(scale.chunks);
    expect(Number(row?.indexes)).toBe(1);
  });

  test('builds the same Organization from the same seed, and another from another', async () => {
    await truncateAll(db);
    const again = await seedLargeOrganization(db, { scale });
    expect(again.counts).toEqual(first.counts);
    expect(await fingerprintLargeOrganization(db)).toBe(firstFingerprint);

    await truncateAll(db);
    await seedLargeOrganization(db, { scale, seed: 74 });
    expect(await fingerprintLargeOrganization(db)).not.toBe(firstFingerprint);
    expect((await countLargeOrganization(db)).decisionRequests).toBe(first.counts.decisionRequests);
  }, 60_000);
});
