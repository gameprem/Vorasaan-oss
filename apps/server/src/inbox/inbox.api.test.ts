import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { NotificationType, PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import type {
  DecideResult,
  DecisionRequestView,
  DelegationView,
  InboxItem,
  NotificationList,
  NotificationView,
  ReadAllNotificationsResult,
  SpecVersionView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const versions = `/features/${SEED.featureId}/spec-versions`;

describe('Inbox Items and Notifications', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asBeam: ReturnType<typeof as>;
  let asPim: ReturnType<typeof as>;

  /** A new person in the seeded Team, optionally a Role Owner on the seeded Feature. */
  async function person(name: string, teamRoles: TeamRole[], ownerRoles: TeamRole[] = []) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    for (const role of teamRoles) {
      await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: user.id, role } });
    }
    for (const role of ownerRoles) {
      await db.roleOwner.create({ data: { featureId: SEED.featureId, userId: user.id, role } });
    }
    return { id: user.id, name, call: as(app, user.id) };
  }

  /** Beam raises a Blocker for the PO and sends it to every PO Role Owner. */
  async function sendToPo(): Promise<DecisionRequestView> {
    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    const sent = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      { deciderRole: 'PO', recipients: 'ALL' },
    );
    expect(sent.status).toBe(201);
    return sent.body;
  }

  const decide = (call: ReturnType<typeof as>, id: string) =>
    call<DecideResult>('POST', `/decision-requests/${id}/decision`, {
      customAnswer: 'Poll every 5 seconds',
    });

  async function inbox(call: ReturnType<typeof as>) {
    const res = await call<InboxItem[]>('GET', '/inbox');
    expect(res.status).toBe(200);
    return res.body;
  }
  const kinds = async (call: ReturnType<typeof as>) => (await inbox(call)).map((i) => i.kind);

  async function notifications(call: ReturnType<typeof as>) {
    const res = await call<NotificationList>('GET', '/notifications');
    expect(res.status).toBe(200);
    return res.body;
  }
  /** Every Notification in the database, as `type → recipient ids`. */
  async function sent(): Promise<Partial<Record<NotificationType, string[]>>> {
    const rows = await db.notification.findMany({ orderBy: { userId: 'asc' } });
    const out: Partial<Record<NotificationType, string[]>> = {};
    for (const row of rows) out[row.type] = [...(out[row.type] ?? []), row.userId];
    for (const ids of Object.values(out)) ids.sort();
    return out;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    asBeam = as(app, beam.id);
    asPim = as(app, pim.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
  });

  // ─── Inbox Items ──────────────────────────────────────────────────────────

  test('DECIDE appears for the Decider and goes when they decide; APPROVE_PROPOSAL follows', async () => {
    expect(await inbox(asPim)).toEqual([]);
    const request = await sendToPo();

    const [item] = await inbox(asPim);
    expect(item).toMatchObject({
      kind: 'DECIDE',
      feature: { id: SEED.featureId, title: 'Async checkout' },
      decisionRequest: {
        id: request.id,
        title: 'Provider has no webhook',
        kind: 'BLOCKER',
        raiser: { id: beam.id, name: 'Beam' },
        deciderRole: 'PO',
        onBehalfOf: null,
      },
    });
    expect(await inbox(asBeam)).toEqual([]);

    const decided = await decide(asPim, request.id);
    expect(decided.status).toBe(201);
    const items = await inbox(asPim);
    expect(items).toEqual([
      {
        kind: 'APPROVE_PROPOSAL',
        feature: { id: SEED.featureId, title: 'Async checkout' },
        since: expect.any(String),
        specProposal: {
          id: decided.body.proposal.id,
          source: 'DECISION',
          decisionRequest: { id: request.id, title: 'Provider has no webhook', kind: 'BLOCKER' },
        },
      },
    ]);

    await asPim('POST', `/spec-proposals/${decided.body.proposal.id}/approve`);
    expect(await inbox(asPim)).toEqual([]);
  });

  test('a rejected Spec Proposal leaves the Inbox too', async () => {
    const request = await sendToPo();
    const decided = await decide(asPim, request.id);
    expect(await kinds(asPim)).toEqual(['APPROVE_PROPOSAL']);
    await asPim('POST', `/spec-proposals/${decided.body.proposal.id}/reject`);
    expect(await inbox(asPim)).toEqual([]);
  });

  test('CLAIM appears for every recipient and becomes DECIDE for the one who Claims', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const request = await sendToPo();
    expect(await kinds(asPim)).toEqual(['CLAIM']);
    expect(await kinds(ploy.call)).toEqual(['CLAIM']);
    // Matches `GET /decision-requests?recipient=me`.
    const mine = await ploy.call<DecisionRequestView[]>('GET', '/decision-requests?recipient=me');
    expect(mine.body.map((r) => r.id)).toEqual([request.id]);

    await ploy.call('POST', `/decision-requests/${request.id}/claim`);
    expect(await kinds(ploy.call)).toEqual(['DECIDE']);
    expect(await inbox(asPim)).toEqual([]);
  });

  test('ANSWER appears for the Raiser while NEEDS_INFO and goes once answered', async () => {
    const request = await sendToPo();
    await asPim('POST', `/decision-requests/${request.id}/messages`, {
      kind: 'QUESTION',
      body: 'How often can we poll?',
    });
    expect(await inbox(asPim)).toEqual([]);
    expect(await inbox(asBeam)).toEqual([
      {
        kind: 'ANSWER',
        feature: { id: SEED.featureId, title: 'Async checkout' },
        since: expect.any(String),
        decisionRequest: {
          id: request.id,
          title: 'Provider has no webhook',
          kind: 'BLOCKER',
          decider: { id: pim.id, name: 'Pim' },
        },
        question: 'How often can we poll?',
      },
    ]);

    await asBeam('POST', `/decision-requests/${request.id}/messages`, {
      kind: 'ANSWER',
      body: 'Every 5 seconds.',
    });
    expect(await inbox(asBeam)).toEqual([]);
    expect(await kinds(asPim)).toEqual(['DECIDE']);
  });

  test('withdrawing removes the Inbox Item', async () => {
    const request = await sendToPo();
    expect(await kinds(asPim)).toEqual(['DECIDE']);
    await asBeam('POST', `/decision-requests/${request.id}/withdraw`);
    expect(await inbox(asPim)).toEqual([]);
  });

  test('a Delegate sees who they received the request for', async () => {
    const pom = await person('Pom', ['PO']);
    await db.delegation.create({
      data: {
        teamId: SEED.teamId,
        role: 'PO',
        delegatorId: pim.id,
        delegateId: pom.id,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
        createdById: pim.id,
      },
    });
    await sendToPo();
    const [item] = await inbox(pom.call);
    expect(item?.kind).toBe('DECIDE');
    expect(item?.kind === 'DECIDE' && item.decisionRequest.onBehalfOf).toEqual({
      id: pim.id,
      name: 'Pim',
    });
    expect(await inbox(asPim)).toEqual([]);
  });

  // ─── Notifications ────────────────────────────────────────────────────────

  test('REQUEST_DECIDED goes to the Raiser, never to the Decider', async () => {
    const request = await sendToPo();
    await decide(asPim, request.id);
    expect(await sent()).toEqual({ REQUEST_DECIDED: [beam.id] });

    const list = await notifications(asBeam);
    expect(list.unreadCount).toBe(1);
    expect(list.notifications).toEqual([
      {
        id: expect.any(String),
        type: 'REQUEST_DECIDED',
        feature: { id: SEED.featureId, title: 'Async checkout' },
        decisionRequest: {
          id: request.id,
          title: 'Provider has no webhook',
          kind: 'BLOCKER',
          status: 'DECIDED',
        },
        specVersion: null,
        delegation: null,
        readAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect((await notifications(asPim)).notifications).toEqual([]);
  });

  test('REQUEST_CLAIMED goes to the other recipients on an explicit Claim', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const pom = await person('Pom', ['PO'], ['PO']);
    const request = await sendToPo();
    await ploy.call('POST', `/decision-requests/${request.id}/claim`);
    expect(await sent()).toEqual({ REQUEST_CLAIMED: [pim.id, pom.id].sort() });
  });

  test('deciding without Claiming first Claims it implicitly: others hear of both', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const request = await sendToPo();
    await decide(ploy.call, request.id);
    expect(await sent()).toEqual({ REQUEST_CLAIMED: [pim.id], REQUEST_DECIDED: [beam.id] });
  });

  test('asking a question without Claiming first Claims it implicitly', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const request = await sendToPo();
    await ploy.call('POST', `/decision-requests/${request.id}/messages`, {
      kind: 'QUESTION',
      body: 'How often can we poll?',
    });
    expect(await sent()).toEqual({ REQUEST_CLAIMED: [pim.id] });
  });

  test('REQUEST_WITHDRAWN goes to the Decider, or to every recipient when there is none', async () => {
    const one = await sendToPo();
    await asBeam('POST', `/decision-requests/${one.id}/withdraw`);
    expect(await sent()).toEqual({ REQUEST_WITHDRAWN: [pim.id] });

    await db.notification.deleteMany();
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const two = await sendToPo();
    await asBeam('POST', `/decision-requests/${two.id}/withdraw`);
    expect(await sent()).toEqual({ REQUEST_WITHDRAWN: [pim.id, ploy.id].sort() });
  });

  test('withdrawing a DRAFT notifies nobody', async () => {
    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Retry policy?',
      description: 'How many retries?',
    });
    await asBeam('POST', `/decision-requests/${draft.body.id}/withdraw`);
    expect(await sent()).toEqual({});
  });

  test('SPEC_VERSION_CREATED goes to the PO Role Owners but the approver, on approve', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const request = await sendToPo();
    await asPim('POST', `/decision-requests/${request.id}/claim`);
    const decided = await decide(asPim, request.id);
    await db.notification.deleteMany();

    await asPim('POST', `/spec-proposals/${decided.body.proposal.id}/approve`);
    expect(await sent()).toEqual({ SPEC_VERSION_CREATED: [ploy.id] });
    const [n] = (await notifications(ploy.call)).notifications;
    expect(n?.specVersion).toEqual({
      id: expect.any(String),
      version: 2,
      approvedBy: { id: pim.id, name: 'Pim' },
    });
    expect(n?.feature).toEqual({ id: SEED.featureId, title: 'Async checkout' });
  });

  test('SPEC_VERSION_CREATED also follows a manual edit and a revert', async () => {
    const ploy = await person('Ploy', ['PO'], ['PO']);
    const edited = await asPim<SpecVersionView>('POST', versions, {
      markdown: `${SEED_SPEC_V1}\n## Notes\nPoll every 5 seconds.\n`,
      baseVersion: 1,
    });
    expect(edited.status).toBe(201);
    expect(await sent()).toEqual({ SPEC_VERSION_CREATED: [ploy.id] });

    const reverted = await ploy.call('POST', `${versions}/1/revert`, { baseVersion: 2 });
    expect(reverted.status).toBe(201);
    expect(await sent()).toEqual({ SPEC_VERSION_CREATED: [pim.id, ploy.id].sort() });
  });

  test('DELEGATION_STARTED goes to the Delegate of an active Delegation, not its creator', async () => {
    const pom = await person('Pom', ['PO']);
    const created = await asPim<DelegationView>('POST', `/teams/${SEED.teamId}/delegations`, {
      delegateId: pom.id,
      role: 'PO',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(await sent()).toEqual({ DELEGATION_STARTED: [pom.id] });

    const [n] = (await notifications(pom.call)).notifications;
    expect(n?.delegation).toEqual({
      id: created.body.id,
      teamId: SEED.teamId,
      role: 'PO',
      delegator: { id: pim.id, name: 'Pim' },
      startsAt: created.body.startsAt,
      endsAt: created.body.endsAt,
    });
  });

  test('DELEGATION_STARTED for a future Delegation is written once it has started', async () => {
    const pom = await person('Pom', ['PO']);
    const created = await asPim<DelegationView>('POST', `/teams/${SEED.teamId}/delegations`, {
      delegateId: pom.id,
      role: 'PO',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await notifications(pom.call)).notifications).toEqual([]);

    // Time passes: the Delegation starts.
    await db.delegation.update({
      where: { id: created.body.id },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    await inbox(pom.call);
    const list = await notifications(pom.call);
    expect(list.notifications.map((n) => n.type)).toEqual(['DELEGATION_STARTED']);
    expect(await sent()).toEqual({ DELEGATION_STARTED: [pom.id] });
    // Pim's reads never materialise Pom's.
    await notifications(asPim);
    expect(await db.notification.count()).toBe(1);
  });

  test('marking read: one, then all; nobody else’s', async () => {
    const one = await sendToPo();
    await asBeam('POST', `/decision-requests/${one.id}/withdraw`);
    const two = await sendToPo();
    await decide(asPim, two.id);
    await asBeam('POST', `/decision-requests/${(await sendToPo()).id}/withdraw`);

    const [pimsFirst] = (await notifications(asPim)).notifications;
    if (!pimsFirst) throw new Error('expected a Notification for Pim');
    expect((await asBeam('POST', `/notifications/${pimsFirst.id}/read`)).status).toBe(404);

    const read = await asPim<NotificationView>('POST', `/notifications/${pimsFirst.id}/read`);
    expect(read.status).toBe(201);
    expect(read.body.readAt).toEqual(expect.any(String));
    const pims = await notifications(asPim);
    expect(pims.unreadCount).toBe(1);
    const unread = await asPim<NotificationList>('GET', '/notifications?unread=true');
    expect(unread.body.notifications.map((n) => n.id)).not.toContain(pimsFirst.id);

    const all = await asPim<ReadAllNotificationsResult>('POST', '/notifications/read-all');
    expect(all.body).toEqual({ updated: 1 });
    expect((await notifications(asPim)).unreadCount).toBe(0);
    // Beam's REQUEST_DECIDED is untouched.
    expect((await notifications(asBeam)).unreadCount).toBe(1);
  });
});
