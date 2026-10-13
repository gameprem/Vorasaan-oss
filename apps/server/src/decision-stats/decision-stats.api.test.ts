import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { DecisionRequestView, DecisionStatsView } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import type { FakeClock } from '../test/fake-clock.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

// The default calendar: UTC, Monday to Friday 09:00-18:00. 2026-10-05 is a Monday.
const at = (local: string) => new Date(`2026-10-${local}:00Z`);
const STATS = `/projects/${SEED.projectId}/decision-stats`;

describe('Decision Lead Time (ticket 0056)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let clock: FakeClock;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  /** A new person in the seeded Organization and Team, optionally a Role Owner of the Feature. */
  async function person(name: string, teamRoles: TeamRole[], ownerRoles: TeamRole[] = []) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id },
    });
    for (const role of teamRoles) {
      await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: user.id, role } });
    }
    for (const role of ownerRoles) {
      await db.roleOwner.create({ data: { featureId: SEED.featureId, userId: user.id, role } });
    }
    return { id: user.id, name, call: as(app, user.id) };
  }

  /** Beam raises a request and sends it to the PO role at the clock's time. */
  async function send(
    kind: 'BLOCKER' | 'QUESTION' = 'BLOCKER',
    recipients: 'ALL' | { userId: string } = 'ALL',
  ): Promise<DecisionRequestView> {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind,
      title: `Provider has no webhook (${kind})`,
      description: 'Only polling is available.',
    });
    const { status, body } = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO', recipients },
    );
    expect(status).toBe(201);
    return body;
  }

  async function decide(call: ReturnType<typeof as>, request: DecisionRequestView) {
    const { status } = await call('POST', `/decision-requests/${request.id}/decision`, {
      choiceId: request.choices[0]?.id,
    });
    expect(status).toBe(201);
  }

  const message = (call: ReturnType<typeof as>, id: string, kind: string) =>
    call('POST', `/decision-requests/${id}/messages`, { kind, body: `A ${kind}` });

  const stats = async (query = '') => {
    const res = await asBeam<DecisionStatsView>('GET', `${STATS}${query}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    ({ app, clock } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    clock.reset();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    clock.reset();
    await truncateAll(db);
    await seed(db);
  });

  test('lead time leaves out the time spent waiting for the Raiser in NEEDS_INFO', async () => {
    clock.set(at('05T10:00'));
    const asked = await send('BLOCKER');
    clock.set(at('05T11:00'));
    expect((await message(asPim, asked.id, 'QUESTION')).status).toBe(201);
    // Three hours waiting for Beam's answer, a note meanwhile changes nothing.
    clock.set(at('05T12:00'));
    expect((await message(asBeam, asked.id, 'NOTE')).status).toBe(201);
    clock.set(at('05T14:00'));
    expect((await message(asBeam, asked.id, 'ANSWER')).status).toBe(201);
    clock.set(at('05T15:00'));
    await decide(asPim, asked);

    // A Question sent Monday 16:00 and decided Tuesday 10:00: 2h Monday, 1h Tuesday.
    clock.set(at('05T16:00'));
    const question = await send('QUESTION');
    clock.set(at('06T10:00'));
    await decide(asPim, question);

    clock.set(at('09T12:00'));
    const body = await stats();
    // 10-11 and 14-15 on Monday: two hours, not five.
    expect(body.leadTime.byKind.BLOCKER).toEqual({
      decided: 1,
      medianMinutes: 120,
      p90Minutes: 120,
    });
    expect(body.leadTime.byKind.QUESTION).toEqual({
      decided: 1,
      medianMinutes: 180,
      p90Minutes: 180,
    });
    expect(body.leadTime.all).toEqual({ decided: 2, medianMinutes: 150, p90Minutes: 174 });
    expect(body.to).toBe(at('09T12:00').toISOString());
    expect(body.from).toBe(new Date(at('09T12:00').getTime() - 84 * 86_400_000).toISOString());
    expect(body.timeZone).toBe('UTC');

    // The weekly trend ends at `to`; both were decided in its last week.
    expect(body.weekly).toHaveLength(12);
    expect(body.weekly.at(-1)).toEqual({
      start: at('02T12:00').toISOString(),
      end: at('09T12:00').toISOString(),
      decided: 2,
      medianMinutes: 150,
    });
    expect(body.weekly.slice(0, -1).every((w) => w.decided === 0 && w.medianMinutes === null)).toBe(
      true,
    );

    // Only what was decided in the range counts.
    const before = await stats(
      `?from=${at('01T00:00').toISOString()}&to=${at('06T00:00').toISOString()}`,
    );
    expect(before.leadTime.all).toEqual({ decided: 1, medianMinutes: 120, p90Minutes: 120 });
    expect(before.weekly).toHaveLength(1);
  });

  test('the wait is attributed to the routed Recipients until Claimed, then to the Decider', async () => {
    const mint = await person('Mint', ['PO'], ['PO']);
    clock.set(at('05T10:00'));
    const request = await send('BLOCKER', 'ALL');
    expect(request.decider).toBeNull();
    // Mint Claims it at noon, then hands it to Pim at 13:00, who decides at 13:30.
    clock.set(at('05T12:00'));
    expect((await mint.call('POST', `/decision-requests/${request.id}/claim`)).status).toBe(201);
    clock.set(at('05T13:00'));
    expect(
      (await mint.call('POST', `/decision-requests/${request.id}/reassign`, { userId: pim.id }))
        .status,
    ).toBe(201);
    clock.set(at('05T13:30'));
    await decide(asPim, request);

    // Still open, sent to Pim alone: it waits on her until now.
    clock.set(at('06T09:00'));
    await send('QUESTION', { userId: pim.id });

    clock.set(at('06T10:00'));
    const body = await stats();
    expect(body.leadTime.all).toEqual({ decided: 1, medianMinutes: 210, p90Minutes: 210 });
    expect(body.waited.byPerson).toEqual([
      // 10-12 as a Recipient, 13-13:30 as Decider, then 1h on the open Question.
      { person: { id: pim.id, name: 'Pim' }, minutes: 210, requests: 2 },
      // 10-12 as a Recipient, 12-13 as the Claimer.
      { person: { id: mint.id, name: 'Mint' }, minutes: 180, requests: 1 },
    ]);
    // The role counts the Blocker's 3.5 hours once, not per Recipient, plus the Question's hour.
    expect(body.waited.byRole).toEqual([{ role: 'PO', minutes: 270, requests: 2 }]);
  });

  test('a Claim implied by asking a question moves the wait to the one who asked', async () => {
    const mint = await person('Mint', ['PO'], ['PO']);
    clock.set(at('05T10:00'));
    const request = await send('BLOCKER', 'ALL');
    clock.set(at('05T11:00'));
    expect((await message(mint.call, request.id, 'QUESTION')).status).toBe(201);
    clock.set(at('05T12:00'));
    await message(asBeam, request.id, 'ANSWER');
    clock.set(at('05T13:00'));
    await decide(mint.call, request);

    clock.set(at('05T17:00'));
    const body = await stats();
    expect(body.leadTime.all.medianMinutes).toBe(120);
    expect(body.waited.byPerson.map((w) => [w.person.name, w.minutes])).toEqual([
      ['Mint', 120],
      ['Pim', 60],
    ]);
  });

  test('counts and lists the requests overdue now; one waiting in NEEDS_INFO is not', async () => {
    clock.set(at('05T10:00'));
    const blocker = await send('BLOCKER');
    const paused = await send('BLOCKER');
    clock.set(at('05T11:00'));
    await message(asPim, paused.id, 'QUESTION');
    const question = await send('QUESTION');

    // The Blockers were due 14:00; the Question is due Wednesday 11:00.
    clock.set(at('05T15:00'));
    const body = await stats();
    expect(body.overdue.count).toBe(1);
    expect(body.overdue.requests).toEqual([
      {
        id: blocker.id,
        title: blocker.title,
        kind: 'BLOCKER',
        featureId: SEED.featureId,
        featureTitle: 'Async checkout',
        deciderRole: 'PO',
        waitingOn: [{ id: pim.id, name: 'Pim' }],
        responseWindow: { dueAt: at('05T14:00').toISOString(), paused: false, escalationStep: 0 },
      },
    ]);

    clock.set(at('08T12:00'));
    const later = await stats();
    expect(later.overdue.count).toBe(2);
    // Most overdue first.
    expect(later.overdue.requests.map((r) => r.id)).toEqual([blocker.id, question.id]);
  });

  test('only members of the Organization see it; bad ranges are refused', async () => {
    const other = await db.organization.create({ data: { name: 'Other' } });
    const stranger = await db.user.create({
      data: { email: 'stranger@other.test', name: 'Stranger', passwordHash: 'x' },
    });
    await db.orgMembership.create({ data: { organizationId: other.id, userId: stranger.id } });
    expect((await as(app, stranger.id)('GET', STATS)).status).toBe(404);
    expect((await asBeam('GET', `/projects/${SEED.featureId}/decision-stats`)).status).toBe(404);
    expect((await asBeam('GET', `${STATS}?from=yesterday`)).status).toBe(400);
    expect(
      (
        await asBeam(
          'GET',
          `${STATS}?from=${at('09T00:00').toISOString()}&to=${at('05T00:00').toISOString()}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await asBeam('GET', `${STATS}?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status,
    ).toBe(400);
    // `from` alone runs to now, which is too far here.
    expect((await asBeam('GET', `${STATS}?from=2024-01-01T00:00:00Z`)).status).toBe(400);

    // An empty Project has nothing to show, not an error.
    const body = await stats();
    expect(body.leadTime.all).toEqual({ decided: 0, medianMinutes: null, p90Minutes: null });
    expect(body.overdue).toEqual({ count: 0, requests: [] });
    expect(body.waited).toEqual({ byPerson: [], byRole: [] });
  });
});
