import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { DecisionLogEntry, DecisionRequestView, DelegationView } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users; // Pim: Admin, PO Role Owner. Beam: Member, BACKEND.
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const url = `/teams/${SEED.teamId}/delegations`;

describe('Delegations API', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asBeam: ReturnType<typeof as>;
  let asPim: ReturnType<typeof as>;

  /** A new Member in the seeded Team, optionally a Role Owner on the seeded Feature. */
  async function person(name: string, teamRoles: TeamRole[], ownerRoles: TeamRole[] = []) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
    });
    for (const role of teamRoles) {
      await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: user.id, role } });
    }
    for (const role of ownerRoles) {
      await db.roleOwner.create({ data: { featureId: SEED.featureId, userId: user.id, role } });
    }
    return { id: user.id, name, call: as(app, user.id) };
  }

  /** Writes a Delegation straight to the database, for routing tests. */
  function delegation(delegatorId: string, delegateId: string, from: number, to: number) {
    return db.delegation.create({
      data: {
        teamId: SEED.teamId,
        role: 'PO',
        delegatorId,
        delegateId,
        startsAt: new Date(at(from)),
        endsAt: new Date(at(to)),
        createdById: delegatorId,
      },
    });
  }

  /** Beam raises a Blocker and sends it to the PO role. */
  async function submit(recipients: 'ALL' | { userId: string } = 'ALL') {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    return asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: 'PO',
      recipients,
    });
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

  // ─── Managing Delegations ─────────────────────────────────────────────────

  test('a Member names their own Delegate; the Team can list it', async () => {
    const nok = await person('Nok', ['PO']);
    const tee = await person('Tee', ['PO']);
    const res = await nok.call<DelegationView>('POST', url, {
      delegateId: tee.id,
      role: 'PO',
      startsAt: at(-1),
      endsAt: at(7),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      teamId: SEED.teamId,
      role: 'PO',
      delegator: { id: nok.id, name: 'Nok' },
      delegate: { id: tee.id, name: 'Tee' },
      createdBy: { id: nok.id, name: 'Nok' },
      active: true,
      canDelete: true,
    });

    const list = await asBeam<DelegationView[]>('GET', url);
    expect(list.status).toBe(200);
    expect(list.body.map((d) => [d.id, d.canDelete])).toEqual([[res.body.id, false]]);
  });

  test('the list leaves out Delegations that have ended', async () => {
    const nok = await person('Nok', ['PO']);
    await delegation(pim.id, nok.id, -10, -3);
    const upcoming = await delegation(pim.id, nok.id, 3, 10);
    const list = await asPim<DelegationView[]>('GET', url);
    expect(list.body.map((d) => [d.id, d.active])).toEqual([[upcoming.id, false]]);
  });

  test('the Delegate must hold the Team Role in that Team and not be the delegator (422)', async () => {
    const nok = await person('Nok', ['DESIGNER']);
    const body = { role: 'PO', startsAt: at(0), endsAt: at(7) };
    expect((await asPim('POST', url, { ...body, delegateId: nok.id })).status).toBe(422);
    expect((await asPim('POST', url, { ...body, delegateId: pim.id })).status).toBe(422);
    expect((await asPim('POST', url, { ...body, delegateId: crypto.randomUUID() })).status).toBe(
      422,
    );
    // The delegator must hold it too: Beam is BACKEND, not PO.
    const tee = await person('Tee', ['PO']);
    expect((await asBeam('POST', url, { ...body, delegateId: tee.id })).status).toBe(422);
  });

  test('the range must end after it starts (400) and not already be over (422)', async () => {
    const nok = await person('Nok', ['PO']);
    const body = { delegateId: nok.id, role: 'PO' };
    expect((await asPim('POST', url, { ...body, startsAt: at(2), endsAt: at(1) })).status).toBe(
      400,
    );
    expect((await asPim('POST', url, { ...body, startsAt: at(-5), endsAt: at(-1) })).status).toBe(
      422,
    );
  });

  test('a delegator cannot have two overlapping Delegations for one Team Role (409)', async () => {
    const nok = await person('Nok', ['PO']);
    const tee = await person('Tee', ['PO']);
    const first = { delegateId: nok.id, role: 'PO', startsAt: at(0), endsAt: at(7) };
    expect((await asPim('POST', url, first)).status).toBe(201);
    const overlap = { delegateId: tee.id, role: 'PO', startsAt: at(6), endsAt: at(9) };
    expect((await asPim('POST', url, overlap)).status).toBe(409);
    // Back-to-back is fine: the first ends exactly when the next starts.
    const next = { delegateId: tee.id, role: 'PO', startsAt: first.endsAt, endsAt: at(9) };
    expect((await asPim('POST', url, next)).status).toBe(201);
  });

  test('a Member cannot name a Delegate for someone else (403); an Admin can', async () => {
    const nok = await person('Nok', ['PO']);
    const tee = await person('Tee', ['PO']);
    const body = {
      delegatorId: nok.id,
      delegateId: tee.id,
      role: 'PO',
      startsAt: at(0),
      endsAt: at(3),
    };
    expect((await asBeam('POST', url, body)).status).toBe(403);
    expect((await tee.call('POST', url, body)).status).toBe(403);

    const res = await asPim<DelegationView>('POST', url, body);
    expect(res.status).toBe(201);
    expect(res.body.delegator).toEqual({ id: nok.id, name: 'Nok' });
    expect(res.body.createdBy).toEqual({ id: pim.id, name: 'Pim' });
    // Naming yourself explicitly is the same as leaving it out.
    const own = { ...body, startsAt: at(4), endsAt: at(5) };
    expect((await nok.call('POST', url, own)).status).toBe(201);
  });

  test('only the delegator or an Admin can delete a Delegation', async () => {
    const nok = await person('Nok', ['PO']);
    const tee = await person('Tee', ['PO']);
    const mine = await delegation(nok.id, tee.id, 0, 3);
    const pims = await delegation(pim.id, tee.id, 0, 3);

    expect((await tee.call('DELETE', `${url}/${mine.id}`)).status).toBe(403);
    expect((await nok.call('DELETE', `${url}/${pims.id}`)).status).toBe(403);
    expect((await nok.call('DELETE', `${url}/${mine.id}`)).status).toBe(204);
    expect((await asPim('DELETE', `${url}/${mine.id}`)).status).toBe(404);

    const again = await delegation(nok.id, tee.id, 0, 3);
    expect((await asPim('DELETE', `${url}/${again.id}`)).status).toBe(204);
    expect(await db.delegation.count()).toBe(1);
  });

  test('an unknown Team is 404, and a Delegation is only found under its own Team', async () => {
    const nok = await person('Nok', ['PO']);
    const other = crypto.randomUUID();
    expect((await asPim('GET', `/teams/${other}/delegations`)).status).toBe(404);
    const body = { delegateId: nok.id, role: 'PO', startsAt: at(0), endsAt: at(3) };
    expect((await asPim('POST', `/teams/${other}/delegations`, body)).status).toBe(404);
    const d = await delegation(pim.id, nok.id, 0, 3);
    expect((await asPim('DELETE', `/teams/${other}/delegations/${d.id}`)).status).toBe(404);
  });

  // ─── Routing at submit ────────────────────────────────────────────────────

  test('an active Delegation reroutes a single-recipient request to the Delegate', async () => {
    const nok = await person('Nok', ['PO']);
    await delegation(pim.id, nok.id, -1, 7);
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body.recipients).toEqual([{ id: nok.id, name: 'Nok' }]);
    expect(res.body.decider).toEqual({ id: nok.id, name: 'Nok' });

    // Also when the Raiser picked the delegator by name.
    const named = await submit({ userId: pim.id });
    expect(named.body.decider).toEqual({ id: nok.id, name: 'Nok' });
  });

  test('an expired or future Delegation does not reroute', async () => {
    const nok = await person('Nok', ['PO']);
    await delegation(pim.id, nok.id, -10, -1);
    await delegation(pim.id, nok.id, 1, 10);
    const res = await submit();
    expect(res.body.recipients).toEqual([{ id: pim.id, name: 'Pim' }]);
    expect(res.body.decider).toEqual({ id: pim.id, name: 'Pim' });
  });

  test('a Delegation for another Team Role does not reroute', async () => {
    const nok = await person('Nok', ['PO', 'DESIGNER']);
    await db.teamMembership.create({
      data: { teamId: SEED.teamId, userId: pim.id, role: 'DESIGNER' },
    });
    await db.delegation.create({
      data: {
        teamId: SEED.teamId,
        role: 'DESIGNER',
        delegatorId: pim.id,
        delegateId: nok.id,
        startsAt: new Date(at(-1)),
        endsAt: new Date(at(1)),
        createdById: pim.id,
      },
    });
    const res = await submit();
    expect(res.body.decider).toEqual({ id: pim.id, name: 'Pim' });
  });

  test('if the Delegate is the Raiser, the original recipient keeps the request', async () => {
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' } });
    await delegation(pim.id, beam.id, -1, 7);
    const res = await submit();
    expect(res.body.recipients).toEqual([{ id: pim.id, name: 'Pim' }]);
    expect(res.body.decider).toEqual({ id: pim.id, name: 'Pim' });
  });

  test('one hop only: the Delegate’s own Delegation is not followed', async () => {
    const nok = await person('Nok', ['PO']);
    const tee = await person('Tee', ['PO']);
    await delegation(pim.id, nok.id, -1, 7);
    await delegation(nok.id, tee.id, -1, 7);
    const res = await submit();
    expect(res.body.recipients).toEqual([{ id: nok.id, name: 'Nok' }]);
  });

  test('a Delegate who is already a recipient is not added twice', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    await person('Tee', ['PO'], ['PO']);
    await delegation(pim.id, nok.id, -1, 7);
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body.recipients.map((r) => r.name)).toEqual(['Nok', 'Tee']);
    expect(res.body.decider).toBeNull();
  });

  // ─── Deciding on behalf of ────────────────────────────────────────────────

  test('a Decision made by the Delegate records on whose behalf, in the view and the Log', async () => {
    const nok = await person('Nok', ['PO']);
    await delegation(pim.id, nok.id, -1, 7);
    const req = await submit();
    const res = await nok.call<{ request: DecisionRequestView }>(
      'POST',
      `/decision-requests/${req.body.id}/decision`,
      { choiceId: req.body.choices[0]?.id },
    );
    expect(res.status).toBe(201);
    expect(res.body.request.decision?.decidedBy).toEqual({ id: nok.id, name: 'Nok' });
    expect(res.body.request.decision?.onBehalfOf).toEqual({ id: pim.id, name: 'Pim' });
    const row = await db.decision.findUniqueOrThrow({ where: { requestId: req.body.id } });
    expect(row.onBehalfOfId).toBe(pim.id);

    const log = await asBeam<DecisionLogEntry[]>('GET', `/features/${SEED.featureId}/decision-log`);
    expect(log.body.map((e) => [e.decidedBy.name, e.onBehalfOf?.name])).toEqual([['Nok', 'Pim']]);
  });

  test('a Delegate among several recipients who Claims and decides acts on behalf', async () => {
    const nok = await person('Nok', ['PO']);
    await person('Tee', ['PO'], ['PO']);
    await delegation(pim.id, nok.id, -1, 7);
    const req = await submit();
    expect(req.body.decider).toBeNull();
    const res = await nok.call<{ request: DecisionRequestView }>(
      'POST',
      `/decision-requests/${req.body.id}/decision`,
      { customAnswer: 'Poll every 30s.' },
    );
    expect(res.body.request.decision?.onBehalfOf).toEqual({ id: pim.id, name: 'Pim' });
  });

  test('Claiming a request that reached the delegator is not acting as Delegate', async () => {
    const nok = await person('Nok', ['PO']);
    const req = await submit();
    expect(req.body.decider).toEqual({ id: pim.id, name: 'Pim' });
    // Named after the request went to Pim, so it did not route it.
    await delegation(pim.id, nok.id, 0, 7);
    expect((await nok.call('POST', `/decision-requests/${req.body.id}/claim`)).status).toBe(201);
    const res = await nok.call<{ request: DecisionRequestView }>(
      'POST',
      `/decision-requests/${req.body.id}/decision`,
      { customAnswer: 'Poll every 30s.' },
    );
    expect(res.status).toBe(201);
    expect(res.body.request.decision?.onBehalfOf).toBeNull();
  });

  test('the delegator deciding their own request records no one else', async () => {
    const nok = await person('Nok', ['PO']);
    await delegation(nok.id, pim.id, -1, 7); // Pim is Nok's Delegate, but this one is Pim's own.
    const req = await submit();
    const res = await asPim<{ request: DecisionRequestView }>(
      'POST',
      `/decision-requests/${req.body.id}/decision`,
      { customAnswer: 'Poll every 30s.' },
    );
    expect(res.body.request.decision?.onBehalfOf).toBeNull();
  });
});
