import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecisionRequestView,
  InboxItem,
  ProjectResponseWindowsView,
  ResponseWindowSettingsInput,
  ResponseWindowSettingsView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import type { FakeClock } from '../test/fake-clock.ts';
import { as } from '../test/http.ts';
import type { EscalationJob } from './escalation.job.ts';

const { pim, beam } = SEED.users;

/** A Bangkok wall-clock time (UTC+7, no DST) as an instant. */
const bkk = (local: string) => new Date(`${local}+07:00`);
const iso = (local: string) => bkk(local).toISOString();

const BANGKOK: ResponseWindowSettingsInput = {
  timeZone: 'Asia/Bangkok',
  workingDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  holidays: [],
  blocker: { value: 4, unit: 'WORKING_HOURS' },
  question: { value: 2, unit: 'WORKING_DAYS' },
};

describe('Response Windows and escalation (ticket 0055)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let clock: FakeClock;
  let escalation: EscalationJob;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  async function person(name: string, roles: TeamRole[]) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id },
    });
    for (const role of roles) {
      await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: user.id, role } });
    }
    return { id: user.id, name, call: as(app, user.id) };
  }

  /** Beam raises a request and sends it to the PO role (Pim, the only PO Role Owner). */
  async function send(
    kind: 'BLOCKER' | 'QUESTION' = 'BLOCKER',
    extra: object = {},
  ): Promise<{ status: number; body: DecisionRequestView }> {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind,
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    return asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: 'PO',
      ...extra,
    });
  }

  const settings = (body: ResponseWindowSettingsInput) =>
    asPim<ResponseWindowSettingsView>('PUT', '/settings/response-windows', body);
  const view = async (id: string) =>
    (await asPim<DecisionRequestView>('GET', `/decision-requests/${id}`)).body;
  const notificationsOf = (requestId: string) =>
    db.notification.findMany({
      where: { requestId },
      select: { type: true, userId: true },
      orderBy: [{ type: 'asc' }, { userId: 'asc' }],
    });

  beforeAll(async () => {
    ({ app, clock, escalation } = await createTestApp());
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

  describe('settings', () => {
    test('defaults until an Admin saves: Blocker 4 working hours, Question 2 working days', async () => {
      const { status, body } = await asBeam<ResponseWindowSettingsView>(
        'GET',
        '/settings/response-windows',
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        organizationId: SEED.organizationId,
        timeZone: 'UTC',
        workingDays: [1, 2, 3, 4, 5],
        workStart: '09:00',
        workEnd: '18:00',
        holidays: [],
        blocker: { value: 4, unit: 'WORKING_HOURS' },
        question: { value: 2, unit: 'WORKING_DAYS' },
      });
    });

    test('only an Admin changes them; the holidays come back sorted', async () => {
      const input = {
        ...BANGKOK,
        workingDays: [5, 1, 2, 3, 4],
        holidays: [
          { date: '2026-12-31', name: "New Year's Eve" },
          { date: '2026-10-13', name: 'Memorial Day' },
        ],
      };
      expect((await asBeam('PUT', '/settings/response-windows', input)).status).toBe(403);
      const saved = await settings(input);
      expect(saved.status).toBe(200);
      expect(saved.body.workingDays).toEqual([1, 2, 3, 4, 5]);
      expect(saved.body.holidays.map((h) => h.date)).toEqual(['2026-10-13', '2026-12-31']);
      expect((await settings({ ...BANGKOK, timeZone: 'Nowhere/Land' })).status).toBe(400);
      expect((await settings({ ...BANGKOK, workStart: '18:00', workEnd: '09:00' })).status).toBe(
        400,
      );
      // Replacing drops the holidays left out.
      const replaced = await settings(BANGKOK);
      expect(replaced.body.holidays).toEqual([]);
    });

    test('a Project overrides the defaults per kind; null goes back to the Organization', async () => {
      const url = `/projects/${SEED.projectId}/response-windows`;
      const initial = await asBeam<ProjectResponseWindowsView>('GET', url);
      expect(initial.body).toEqual({
        projectId: SEED.projectId,
        override: { blocker: null, question: null },
        effective: {
          blocker: { value: 4, unit: 'WORKING_HOURS' },
          question: { value: 2, unit: 'WORKING_DAYS' },
        },
      });
      const input = { blocker: { value: 2, unit: 'WORKING_HOURS' }, question: null };
      expect((await asBeam('PUT', url, input)).status).toBe(403);
      const saved = await asPim<ProjectResponseWindowsView>('PUT', url, input);
      expect(saved.status).toBe(200);
      expect(saved.body.effective).toEqual({
        blocker: { value: 2, unit: 'WORKING_HOURS' },
        question: { value: 2, unit: 'WORKING_DAYS' },
      });
      expect((await asPim('GET', `/projects/${SEED.featureId}/response-windows`)).status).toBe(404);
    });
  });

  describe('dueAt on send', () => {
    test('a Blocker sent Friday 16:00, working 09-18 Monday to Friday, is due Monday 11:00', async () => {
      await settings(BANGKOK);
      clock.set(bkk('2026-10-02T16:00'));
      const { status, body } = await send();
      expect(status).toBe(201);
      expect(body.responseWindow).toEqual({
        dueAt: iso('2026-10-05T11:00'),
        paused: false,
        escalationStep: 0,
      });
      expect(body.submittedAt).toBe(iso('2026-10-02T16:00'));
    });

    test('a holiday on that Monday moves it to Tuesday 11:00', async () => {
      await settings({ ...BANGKOK, holidays: [{ date: '2026-10-05', name: 'Bridge day' }] });
      clock.set(bkk('2026-10-02T16:00'));
      expect((await send()).body.responseWindow.dueAt).toBe(iso('2026-10-06T11:00'));
    });

    test("a Question gets 2 working days, and a Project's override wins", async () => {
      await settings(BANGKOK);
      clock.set(bkk('2026-10-06T10:00'));
      expect((await send('QUESTION')).body.responseWindow.dueAt).toBe(iso('2026-10-08T10:00'));
      await asPim('PUT', `/projects/${SEED.projectId}/response-windows`, {
        blocker: { value: 1, unit: 'WORKING_HOURS' },
        question: null,
      });
      expect((await send('BLOCKER')).body.responseWindow.dueAt).toBe(iso('2026-10-06T11:00'));
    });

    test('the Raiser may shorten the window when sending, never lengthen it', async () => {
      await settings(BANGKOK);
      clock.set(bkk('2026-10-05T09:00'));
      const shorter = await send('BLOCKER', {
        responseWindow: { value: 1, unit: 'WORKING_HOURS' },
      });
      expect(shorter.status).toBe(201);
      expect(shorter.body.responseWindow.dueAt).toBe(iso('2026-10-05T10:00'));

      const longer = await send('BLOCKER', { responseWindow: { value: 1, unit: 'WORKING_DAYS' } });
      expect(longer.status).toBe(422);
      expect((longer.body as unknown as { message: string }).message).toContain(
        'can only be shortened',
      );
    });
  });

  test('NEEDS_INFO pauses the clock: the wait for the Raiser does not count', async () => {
    await settings(BANGKOK);
    clock.set(bkk('2026-10-05T09:00')); // Monday
    const { body: sent } = await send();
    expect(sent.responseWindow.dueAt).toBe(iso('2026-10-05T13:00'));

    clock.set(bkk('2026-10-05T10:00'));
    const asked = await asPim<DecisionRequestView>(
      'POST',
      `/decision-requests/${sent.id}/messages`,
      { kind: 'QUESTION', body: 'How often would we poll?' },
    );
    expect(asked.body.responseWindow).toMatchObject({ paused: true });

    // Long past the original dueAt: a paused request never escalates.
    clock.set(bkk('2026-10-06T10:00'));
    expect((await escalation.run()).steps).toEqual([]);

    // 9 working hours waited (Monday 10-18, Tuesday 9-10): due Monday 13:00 + 9h = Tuesday 13:00.
    const answered = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${sent.id}/messages`,
      { kind: 'ANSWER', body: 'Every 30 seconds.' },
    );
    expect(answered.body.responseWindow).toEqual({
      dueAt: iso('2026-10-06T13:00'),
      paused: false,
      escalationStep: 0,
    });
    expect((await escalation.run()).steps).toEqual([]);
  });

  describe('escalation', () => {
    /** Dao is Pim's Delegate for PO all week; Tao is the Team's Tech Lead. */
    async function team() {
      const dao = await person('Dao', ['PO']);
      const tao = await person('Tao', ['TECH_LEAD']);
      await db.delegation.create({
        data: {
          teamId: SEED.teamId,
          role: 'PO',
          delegatorId: pim.id,
          delegateId: dao.id,
          startsAt: bkk('2026-10-05T00:00'),
          endsAt: bkk('2026-10-10T00:00'),
          createdById: pim.id,
        },
      });
      return { dao, tao };
    }

    test('in order: reminder, then the Delegate, then the Raiser and Tech Leads; never twice', async () => {
      await settings(BANGKOK);
      const { dao, tao } = await team();
      clock.set(bkk('2026-10-02T16:00'));
      const { body: sent } = await send();
      // Before the Delegation starts: Pim receives it in their own right and decides.
      expect(sent.decider?.id).toBe(pim.id);
      const id = sent.id;

      // Due Monday 11:00; Delegate half a window (2h) later; Raiser and Tech Leads 2h after that.
      clock.set(bkk('2026-10-05T10:59'));
      expect((await escalation.run()).steps).toEqual([]);

      clock.set(bkk('2026-10-05T11:00'));
      expect((await escalation.run()).steps).toEqual([{ requestId: id, step: 1 }]);
      expect((await escalation.run()).steps).toEqual([]);
      expect(await notificationsOf(id)).toEqual([{ type: 'REQUEST_REMINDER', userId: pim.id }]);
      const pimInbox = await asPim<InboxItem[]>('GET', '/inbox');
      expect(pimInbox.body).toMatchObject([
        { kind: 'DECIDE', decisionRequest: { id, responseWindow: { escalationStep: 1 } } },
      ]);

      clock.set(bkk('2026-10-05T12:59'));
      expect((await escalation.run()).steps).toEqual([]);
      clock.set(bkk('2026-10-05T13:00'));
      expect((await escalation.run()).steps).toEqual([{ requestId: id, step: 2 }]);
      let request = await view(id);
      expect(request.recipients.map((r) => r.id).sort()).toEqual([dao.id, pim.id].sort());
      expect(
        await db.requestRecipient.findUnique({
          where: { requestId_userId: { requestId: id, userId: dao.id } },
          select: { onBehalfOfId: true },
        }),
      ).toEqual({ onBehalfOfId: pim.id });
      // Dao can now Claim it: escalation only made it visible.
      expect(request.decider?.id).toBe(pim.id);

      clock.set(bkk('2026-10-05T15:00'));
      expect((await escalation.run()).steps).toEqual([{ requestId: id, step: 3 }]);
      clock.advance(24 * 60 * 60_000);
      expect((await escalation.run()).steps).toEqual([]);

      request = await view(id);
      expect(request.status).toBe('OPEN');
      expect(request.decider?.id).toBe(pim.id);
      expect(request.responseWindow.escalationStep).toBe(3);
      expect(request.history).toEqual([
        {
          kind: 'REMINDED',
          people: [{ id: pim.id, name: 'Pim' }],
          createdAt: iso('2026-10-05T11:00'),
        },
        {
          kind: 'DELEGATES_ADDED',
          people: [{ id: dao.id, name: 'Dao' }],
          createdAt: iso('2026-10-05T13:00'),
        },
        {
          kind: 'OVERDUE_REPORTED',
          people: [
            { id: beam.id, name: 'Beam' },
            { id: tao.id, name: 'Tao' },
          ],
          createdAt: iso('2026-10-05T15:00'),
        },
      ]);
      const expected = [
        { type: 'REQUEST_REMINDER', userId: pim.id },
        { type: 'REQUEST_ESCALATED', userId: dao.id },
        { type: 'REQUEST_OVERDUE', userId: beam.id },
        { type: 'REQUEST_OVERDUE', userId: tao.id },
      ];
      const sortKey = (n: { type: string; userId: string }) => `${n.type}:${n.userId}`;
      expect((await notificationsOf(id)).map(sortKey).sort()).toEqual(expected.map(sortKey).sort());

      // Dao, now a Recipient, Claims and decides: a person still decides.
      const claimed = await dao.call<DecisionRequestView>('POST', `/decision-requests/${id}/claim`);
      expect(claimed.status).toBe(201);
    });

    test('a run that finds several steps due takes them all, in order', async () => {
      await settings(BANGKOK);
      await team();
      clock.set(bkk('2026-10-02T16:00'));
      const { body: sent } = await send();
      clock.set(bkk('2026-10-06T09:00'));
      expect((await escalation.run()).steps.map((s) => s.step)).toEqual([1, 2, 3]);
      expect((await view(sent.id)).history.map((h) => h.kind)).toEqual([
        'REMINDED',
        'DELEGATES_ADDED',
        'OVERDUE_REPORTED',
      ]);
    });

    test('concurrent runs (several server instances) take each step once', async () => {
      await settings(BANGKOK);
      await team();
      clock.set(bkk('2026-10-02T16:00'));
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await send()).body.id);
      clock.set(bkk('2026-10-06T09:00'));
      const runs = await Promise.all([escalation.run(), escalation.run(), escalation.run()]);
      expect(runs.flatMap((r) => r.steps)).toHaveLength(9);
      expect(await db.requestHistoryEntry.count()).toBe(9);
      expect(await db.notification.count({ where: { type: 'REQUEST_REMINDER' } })).toBe(3);
    });

    test('a decided or withdrawn request stops escalating', async () => {
      await settings(BANGKOK);
      await team();
      clock.set(bkk('2026-10-02T16:00'));
      const decided = (await send()).body;
      const withdrawn = (await send()).body;

      clock.set(bkk('2026-10-05T11:00'));
      expect((await escalation.run()).steps).toHaveLength(2);

      const decision = await asPim('POST', `/decision-requests/${decided.id}/decision`, {
        choiceId: decided.choices[0]?.id,
      });
      expect(decision.status).toBe(201);
      expect((await asBeam('POST', `/decision-requests/${withdrawn.id}/withdraw`)).status).toBe(
        201,
      );

      clock.set(bkk('2026-10-07T11:00'));
      expect((await escalation.run()).steps).toEqual([]);
      const after = await view(decided.id);
      expect(after.status).toBe('DECIDED');
      expect(after.decision?.decidedBy.id).toBe(pim.id);
      expect(after.history.map((h) => h.kind)).toEqual(['REMINDED']);
    });

    test('a request sent to several Recipients reminds all of them, and keeps no Decider', async () => {
      await settings(BANGKOK);
      // A second PO Role Owner: the Blocker goes to both, unclaimed.
      const nok = await person('Nok', ['PO']);
      await db.roleOwner.create({
        data: { featureId: SEED.featureId, userId: nok.id, role: 'PO' },
      });
      clock.set(bkk('2026-10-05T09:00'));
      const { body: sent } = await send();
      expect(sent.decider).toBeNull();
      clock.set(bkk('2026-10-05T13:00'));
      await escalation.run();
      const reminded = await db.notification.findMany({
        where: { requestId: sent.id, type: 'REQUEST_REMINDER' },
        select: { userId: true },
      });
      expect(reminded.map((r) => r.userId).sort()).toEqual([nok.id, pim.id].sort());
      expect((await view(sent.id)).decider).toBeNull();
    });
  });
});
