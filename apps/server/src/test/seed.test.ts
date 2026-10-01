import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed, seedFullTeam } from '@vorasaan/db/seed';
import { createTestPrisma, prepareTestDatabase, truncateAll } from './database.ts';

async function counts(db: PrismaClient) {
  return {
    organizations: await db.organization.count(),
    users: await db.user.count(),
    orgMemberships: await db.orgMembership.count(),
    projects: await db.project.count(),
    teams: await db.team.count(),
    teamMemberships: await db.teamMembership.count(),
    features: await db.feature.count(),
    roleOwners: await db.roleOwner.count(),
    specVersions: await db.specVersion.count(),
  };
}

describe('seed', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    await prepareTestDatabase();
    db = createTestPrisma();
  });

  beforeEach(() => truncateAll(db));

  afterAll(() => db.$disconnect());

  test('creates the tracer-bullet world and is idempotent', async () => {
    await seed(db);
    const first = await counts(db);
    expect(first).toEqual({
      organizations: 1,
      users: 2,
      orgMemberships: 2,
      projects: 1,
      teams: 1,
      teamMemberships: 2,
      features: 1,
      roleOwners: 2,
      specVersions: 1,
    });

    await seed(db);
    expect(await counts(db)).toEqual(first);

    const owners = await db.roleOwner.findMany({
      where: { featureId: SEED.featureId },
      orderBy: { role: 'asc' },
      select: { userId: true, role: true },
    });
    expect(owners).toEqual([
      { userId: SEED.users.pim.id, role: 'PO' },
      { userId: SEED.users.beam.id, role: 'BACKEND' },
    ]);

    const spec = await db.specVersion.findUniqueOrThrow({
      where: { featureId_version: { featureId: SEED.featureId, version: 1 } },
    });
    expect(spec.approvedById).toBe(SEED.users.pim.id);
    expect(spec.markdown).toContain('# Async checkout');
  });

  test('the full Team adds a second PO Role Owner, a Designer and a Tech Lead, idempotently', async () => {
    await seed(db);
    await seedFullTeam(db);
    const first = await counts(db);
    expect(first).toEqual({
      organizations: 1,
      users: 5,
      orgMemberships: 5,
      projects: 1,
      teams: 1,
      teamMemberships: 5,
      features: 1,
      roleOwners: 3,
      specVersions: 1,
    });

    await seed(db);
    await seedFullTeam(db);
    expect(await counts(db)).toEqual(first);

    const { pim, beam, mint, fern, oak } = SEED.users;
    const owners = await db.roleOwner.findMany({
      where: { featureId: SEED.featureId },
      select: { userId: true, role: true },
    });
    expect(owners).toHaveLength(3);
    expect(owners).toEqual(
      expect.arrayContaining([
        { userId: pim.id, role: 'PO' },
        { userId: mint.id, role: 'PO' },
        { userId: beam.id, role: 'BACKEND' },
      ]),
    );
    const members = await db.teamMembership.findMany({
      where: { teamId: SEED.teamId },
      select: { userId: true, role: true },
    });
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: fern.id, role: 'DESIGNER' },
        { userId: oak.id, role: 'TECH_LEAD' },
      ]),
    );
  });
});
