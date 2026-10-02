import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { DecideResult, DecisionRequestView } from '@vorasaan/shared';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

describe('Decision Requests API: recipients, Claim and reassign', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
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

  /** Beam raises a Blocker; returns the DRAFT. */
  async function raise(): Promise<DecisionRequestView> {
    const { body } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    return body;
  }

  async function submit(body: object) {
    const draft = await raise();
    return asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, body);
  }

  const names = (people: { name: string }[]) => people.map((p) => p.name).sort();

  beforeAll(async () => {
    ({ app, ai } = await createTestApp());
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
    ai.calls.length = 0;
  });

  // ─── Submit: choosing recipients ──────────────────────────────────────────

  test('a single Role Owner is selected automatically and becomes the Decider', async () => {
    const res = await submit({ deciderRole: 'PO', recipients: 'ALL' });
    expect(res.status).toBe(201);
    expect(res.body.decider).toEqual({ id: pim.id, name: 'Pim' });
    expect(res.body.recipients).toEqual([{ id: pim.id, name: 'Pim' }]);
    const rows = await db.requestRecipient.findMany({ where: { requestId: res.body.id } });
    expect(rows.map((r) => r.userId)).toEqual([pim.id]);
  });

  test('ALL with two Role Owners → no Decider until one Claims', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const res = await submit({ deciderRole: 'PO', recipients: 'ALL' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.decider).toBeNull();
    expect(names(res.body.recipients)).toEqual(['Nok', 'Pim']);

    // Both see it in their "claim or decide" list and can Claim it.
    for (const call of [asPim, nok.call]) {
      const list = await call<DecisionRequestView[]>('GET', '/decision-requests?recipient=me');
      expect(list.body.map((r) => [r.id, r.canClaim])).toEqual([[res.body.id, true]]);
    }
    // The Raiser cannot.
    const asRaiser = await asBeam<DecisionRequestView>('GET', `/decision-requests/${res.body.id}`);
    expect(asRaiser.body.canClaim).toBe(false);

    const claimed = await nok.call<DecisionRequestView>(
      'POST',
      `/decision-requests/${res.body.id}/claim`,
    );
    expect(claimed.status).toBe(201);
    expect(claimed.body.decider).toEqual({ id: nok.id, name: 'Nok' });
    expect(claimed.body.canClaim).toBe(false);

    // It leaves Pim's list, but she can still Claim it back.
    const pimList = await asPim<DecisionRequestView[]>('GET', '/decision-requests?recipient=me');
    expect(pimList.body).toEqual([]);
    const pimView = await asPim<DecisionRequestView>('GET', `/decision-requests/${res.body.id}`);
    expect(pimView.body.canClaim).toBe(true);
  });

  test('recipient=me lists only OPEN requests: withdrawn or decided ones leave it', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const withdrawn = await submit({ deciderRole: 'PO', recipients: 'ALL' });
    await asBeam('POST', `/decision-requests/${withdrawn.body.id}/withdraw`);
    const decided = await submit({ deciderRole: 'PO', recipients: { userId: nok.id } });
    await nok.call('POST', `/decision-requests/${decided.body.id}/decision`, {
      choiceId: decided.body.choices[0]?.id,
    });

    for (const call of [asPim, nok.call]) {
      const list = await call<DecisionRequestView[]>('GET', '/decision-requests?recipient=me');
      expect(list.body).toEqual([]);
    }
  });

  test('sending to one of several Role Owners makes them the Decider', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const res = await submit({ deciderRole: 'PO', recipients: { userId: nok.id } });
    expect(res.status).toBe(201);
    expect(res.body.decider).toEqual({ id: nok.id, name: 'Nok' });
    expect(res.body.recipients).toEqual([{ id: nok.id, name: 'Nok' }]);
  });

  test('the chosen recipient must be eligible for the role (422)', async () => {
    const tee = await person('Tee', ['PO']); // holds PO, but Pim is the Feature's PO Role Owner
    const draft = await raise();
    const url = `/decision-requests/${draft.id}/submit`;
    for (const userId of [tee.id, beam.id, crypto.randomUUID()]) {
      const res = await asBeam('POST', url, { deciderRole: 'PO', recipients: { userId } });
      expect(res.status).toBe(422);
    }
    expect(await db.requestRecipient.count()).toBe(0);
  });

  test('no Role Owner for the role → the Team members holding it', async () => {
    await person('Tee', ['TECH_LEAD']);
    await person('Ton', ['TECH_LEAD', 'BACKEND']);
    await person('Dao', ['DESIGNER']);
    const res = await submit({ deciderRole: 'TECH_LEAD' });
    expect(res.status).toBe(201);
    expect(res.body.decider).toBeNull();
    expect(names(res.body.recipients)).toEqual(['Tee', 'Ton']);
  });

  test('the Raiser is never a recipient', async () => {
    const ton = await person('Ton', ['BACKEND'], ['BACKEND']);
    const res = await submit({ deciderRole: 'BACKEND' });
    expect(res.body.recipients).toEqual([{ id: ton.id, name: 'Ton' }]);
    expect(res.body.decider).toEqual({ id: ton.id, name: 'Ton' });
  });

  test('when only the Raiser holds the role, submit is 422', async () => {
    const draft = await raise();
    const url = `/decision-requests/${draft.id}/submit`;
    expect((await asBeam('POST', url, { deciderRole: 'BACKEND' })).status).toBe(422);
    expect((await asBeam('POST', url, { deciderRole: 'QA' })).status).toBe(422);
    const still = await asBeam<DecisionRequestView>('GET', `/decision-requests/${draft.id}`);
    expect(still.body.status).toBe('DRAFT');
  });

  // ─── Claim ────────────────────────────────────────────────────────────────

  test('anyone holding the role in the Team can Claim a request routed to someone else', async () => {
    const tee = await person('Tee', ['PO']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    expect(open.decider?.name).toBe('Pim');

    const view = await tee.call<DecisionRequestView>('GET', `/decision-requests/${open.id}`);
    expect(view.body.canClaim).toBe(true);
    const claimed = await tee.call<DecisionRequestView>(
      'POST',
      `/decision-requests/${open.id}/claim`,
    );
    expect(claimed.status).toBe(201);
    expect(claimed.body.decider).toEqual({ id: tee.id, name: 'Tee' });
    // Pim is no longer the Decider.
    const pimDecides = await asPim('POST', `/decision-requests/${open.id}/decision`, {
      customAnswer: 'Poll',
    });
    expect(pimDecides.status).toBe(403);
  });

  test('Claim by a non-holder of the role, or by the Raiser, is 403', async () => {
    const dao = await person('Dao', ['DESIGNER']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    const url = `/decision-requests/${open.id}/claim`;
    expect((await dao.call('POST', url)).status).toBe(403);
    expect((await asBeam('POST', url)).status).toBe(403);
    const view = await dao.call<DecisionRequestView>('GET', `/decision-requests/${open.id}`);
    expect(view.body.canClaim).toBe(false);
  });

  test('Claim outside OPEN is 409; unknown request is 404', async () => {
    const draft = await raise();
    expect((await asPim('POST', `/decision-requests/${draft.id}/claim`)).status).toBe(409);

    const { body: open } = await submit({ deciderRole: 'PO' });
    await asBeam('POST', `/decision-requests/${open.id}/withdraw`);
    expect((await asPim('POST', `/decision-requests/${open.id}/claim`)).status).toBe(409);

    expect((await asPim('POST', `/decision-requests/${crypto.randomUUID()}/claim`)).status).toBe(
      404,
    );
  });

  test('claiming a request I already decide is a no-op', async () => {
    const { body: open } = await submit({ deciderRole: 'PO' });
    const res = await asPim<DecisionRequestView>('POST', `/decision-requests/${open.id}/claim`);
    expect(res.status).toBe(201);
    expect(res.body.decider?.name).toBe('Pim');
  });

  // ─── Deciding as a recipient ──────────────────────────────────────────────

  test('a recipient deciding without claiming becomes the Decider', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    expect(open.decider).toBeNull();

    const res = await nok.call<DecideResult>('POST', `/decision-requests/${open.id}/decision`, {
      choiceId: open.choices[0]?.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('DECIDED');
    expect(res.body.request.decider).toEqual({ id: nok.id, name: 'Nok' });
    expect(res.body.request.decision?.decidedBy.name).toBe('Nok');
    expect(res.body.proposal.approver.id).toBe(nok.id);
  });

  test('without a Claim, only recipients may decide; after a Claim, only the Decider', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const tee = await person('Tee', ['PO']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    const url = `/decision-requests/${open.id}/decision`;

    // Tee holds the role but was not sent the request: she must Claim first.
    expect((await tee.call('POST', url, { customAnswer: 'Poll' })).status).toBe(403);

    await nok.call('POST', `/decision-requests/${open.id}/claim`);
    expect((await asPim('POST', url, { customAnswer: 'Poll' })).status).toBe(403);
    expect((await nok.call('POST', url, { customAnswer: 'Poll' })).status).toBe(201);
  });

  // ─── Reassign ─────────────────────────────────────────────────────────────

  test('the Decider can reassign to someone else holding the role', async () => {
    const tee = await person('Tee', ['PO']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    const res = await asPim<DecisionRequestView>('POST', `/decision-requests/${open.id}/reassign`, {
      userId: tee.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.decider).toEqual({ id: tee.id, name: 'Tee' });

    const inbox = await tee.call<DecisionRequestView[]>(
      'GET',
      '/decision-requests?decider=me&status=OPEN',
    );
    expect(inbox.body.map((r) => r.id)).toEqual([open.id]);
  });

  test('reassign to the Raiser, or to someone without the role, is rejected', async () => {
    const dao = await person('Dao', ['DESIGNER']);
    const { body: open } = await submit({ deciderRole: 'PO' });
    const url = `/decision-requests/${open.id}/reassign`;
    expect((await asPim('POST', url, { userId: beam.id })).status).toBe(422);
    expect((await asPim('POST', url, { userId: dao.id })).status).toBe(422);
    expect((await asPim('POST', url, { userId: crypto.randomUUID() })).status).toBe(422);
    expect((await asPim('POST', url, { userId: pim.id })).status).toBe(422);
    expect((await asPim('POST', url, {})).status).toBe(400);
    const view = await asPim<DecisionRequestView>('GET', `/decision-requests/${open.id}`);
    expect(view.body.decider?.name).toBe('Pim');
  });

  test('only the current Decider can reassign (403), and only while OPEN (409)', async () => {
    const tee = await person('Tee', ['PO']);
    const nok = await person('Nok', ['PO'], ['PO']);
    const { body: unclaimed } = await submit({ deciderRole: 'PO' });
    const unclaimedUrl = `/decision-requests/${unclaimed.id}/reassign`;
    // No Decider yet: a recipient must Claim before reassigning.
    expect((await nok.call('POST', unclaimedUrl, { userId: tee.id })).status).toBe(403);
    expect((await asBeam('POST', unclaimedUrl, { userId: tee.id })).status).toBe(403);

    const { body: toNok } = await submit({ deciderRole: 'PO', recipients: { userId: nok.id } });
    const url = `/decision-requests/${toNok.id}/reassign`;
    expect((await asPim('POST', url, { userId: tee.id })).status).toBe(403);
    await nok.call('POST', `/decision-requests/${toNok.id}/decision`, { customAnswer: 'Poll' });
    expect((await nok.call('POST', url, { userId: tee.id })).status).toBe(409);
  });
});
