import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import { MyTeamView } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users; // Pim: Admin, PO. Beam: Member, BACKEND.

describe('GET /me/teams', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;

  /** A Member of the Organization who is in no Team yet. */
  async function member(name: string) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
    });
    return user;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
  });

  test("returns the caller's Teams with their Project, Team Roles and members", async () => {
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'QA' } });

    const res = await as(app, beam.id)<MyTeamView[]>('GET', '/me/teams');

    expect(res.status).toBe(200);
    const teams = MyTeamView.array().parse(res.body);
    expect(teams).toHaveLength(1);
    const [team] = teams;
    expect(team?.id).toBe(SEED.teamId);
    expect(team?.project.id).toBe(SEED.projectId);
    expect(team?.myRoles.toSorted()).toEqual(['BACKEND', 'QA']);
    const roles = Object.fromEntries(team?.members.map((m) => [m.userId, m.roles]) ?? []);
    expect(roles[pim.id]).toEqual(['PO']);
    expect(roles[beam.id]?.toSorted()).toEqual(['BACKEND', 'QA']);
  });

  test("another user's Teams never appear", async () => {
    const otherTeam = await db.team.create({
      data: { projectId: SEED.projectId, name: 'Payments' },
    });
    const nok = await member('Nok');
    await db.teamMembership.create({ data: { teamId: otherTeam.id, userId: nok.id, role: 'PO' } });

    const asBeam = await as(app, beam.id)<MyTeamView[]>('GET', '/me/teams');
    expect(asBeam.body.map((t) => t.id)).toEqual([SEED.teamId]);

    const asNok = await as(app, nok.id)<MyTeamView[]>('GET', '/me/teams');
    expect(asNok.body.map((t) => t.id)).toEqual([otherTeam.id]);
    expect(asNok.body[0]?.members.map((m) => m.userId)).toEqual([nok.id]);
  });

  test('is empty for someone in no Team, Admin or not', async () => {
    const nok = await member('Nok');
    await db.teamMembership.deleteMany({ where: { userId: pim.id } });

    for (const id of [nok.id, pim.id]) {
      const res = await as(app, id)<MyTeamView[]>('GET', '/me/teams');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });

  test('lists Teams by Project, then Team name', async () => {
    const zeta = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Zeta' },
    });
    const zetaTeam = await db.team.create({ data: { projectId: zeta.id, name: 'Alpha' } });
    const another = await db.team.create({ data: { projectId: SEED.projectId, name: 'AAA' } });
    for (const teamId of [zetaTeam.id, another.id]) {
      await db.teamMembership.create({ data: { teamId, userId: beam.id, role: 'BACKEND' } });
    }

    const res = await as(app, beam.id)<MyTeamView[]>('GET', '/me/teams');
    expect(res.body.map((t) => t.id)).toEqual([another.id, SEED.teamId, zetaTeam.id]);
  });

  test('needs a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/teams' });
    expect(res.statusCode).toBe(401);
  });
});
