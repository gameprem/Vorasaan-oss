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
const UNKNOWN_ID = '00000000-0000-4000-8000-00000000ffff';

describe('Decision Requests API: ask for more info (NEEDS_INFO thread)', () => {
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
    // A Team member is a member of its Organization, as the app makes them.
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

  /** Beam raises a Blocker and sends it to the PO role: Pim is its only Role Owner. */
  async function open(): Promise<DecisionRequestView> {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    const { body } = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    return body;
  }

  const messagesUrl = (id: string) => `/decision-requests/${id}/messages`;

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

  test('Decider asks → NEEDS_INFO; Raiser answers → OPEN; the Decider can then decide', async () => {
    const request = await open();
    expect(request.decider?.id).toBe(pim.id);
    expect(request.messages).toEqual([]);

    const asked = await asPim<DecisionRequestView>('POST', messagesUrl(request.id), {
      kind: 'QUESTION',
      body: 'How often would we poll?',
    });
    expect(asked.status).toBe(201);
    expect(asked.body.status).toBe('NEEDS_INFO');
    expect(asked.body.decider?.id).toBe(pim.id);
    expect(asked.body.messages).toMatchObject([
      { kind: 'QUESTION', author: { id: pim.id, name: 'Pim' }, body: 'How often would we poll?' },
    ]);

    // The Raiser finds it with the existing filters.
    const mine = await asBeam<DecisionRequestView[]>(
      'GET',
      '/decision-requests?raiser=me&status=NEEDS_INFO',
    );
    expect(mine.body.map((r) => r.id)).toEqual([request.id]);

    const answered = await asBeam<DecisionRequestView>('POST', messagesUrl(request.id), {
      kind: 'ANSWER',
      body: '  Every 30 seconds.  ',
    });
    expect(answered.status).toBe(201);
    expect(answered.body.status).toBe('OPEN');
    expect(answered.body.decider?.id).toBe(pim.id);
    expect(answered.body.messages.map((m) => [m.kind, m.author.id, m.body])).toEqual([
      ['QUESTION', pim.id, 'How often would we poll?'],
      ['ANSWER', beam.id, 'Every 30 seconds.'],
    ]);

    // Everyone reading the request sees the thread, oldest first.
    const view = await asPim<DecisionRequestView>('GET', `/decision-requests/${request.id}`);
    expect(view.body.messages.map((m) => m.kind)).toEqual(['QUESTION', 'ANSWER']);
    const [first, second] = view.body.messages;
    expect(Date.parse(first?.createdAt ?? '')).toBeLessThanOrEqual(
      Date.parse(second?.createdAt ?? ''),
    );

    const decided = await asPim<DecideResult>('POST', `/decision-requests/${request.id}/decision`, {
      choiceId: request.choices[0]?.id,
    });
    expect(decided.status).toBe(201);
    expect(decided.body.request.status).toBe('DECIDED');
    expect(decided.body.request.messages).toHaveLength(2);
  });

  test('nobody else can post a QUESTION or ANSWER (403)', async () => {
    const nok = await person('Nok', ['PO']); // holds the decider role, but is not the Decider
    const outsider = await person('Dao', ['QA']);
    const request = await open();
    const url = messagesUrl(request.id);

    const question = { kind: 'QUESTION', body: 'Why?' };
    for (const call of [asBeam, nok.call, outsider.call]) {
      expect((await call('POST', url, question)).status).toBe(403);
    }

    await asPim('POST', url, question);
    const answer = { kind: 'ANSWER', body: 'Because.' };
    for (const call of [asPim, nok.call, outsider.call]) {
      expect((await call('POST', url, answer)).status).toBe(403);
    }
    expect(await db.requestMessage.count({ where: { requestId: request.id } })).toBe(1);
  });

  test('wrong state is 409', async () => {
    const request = await open();
    const url = messagesUrl(request.id);

    // Answering when nothing was asked.
    expect((await asBeam('POST', url, { kind: 'ANSWER', body: 'Unasked' })).status).toBe(409);
    // Asking twice.
    await asPim('POST', url, { kind: 'QUESTION', body: 'First?' });
    expect((await asPim('POST', url, { kind: 'QUESTION', body: 'Second?' })).status).toBe(409);
    // Claim and reassign wait until the Raiser answers.
    expect((await asPim('POST', `/decision-requests/${request.id}/claim`)).status).toBe(409);

    // Nothing can be posted once the request is closed.
    await asBeam('POST', `/decision-requests/${request.id}/withdraw`);
    expect((await asBeam('POST', url, { kind: 'ANSWER', body: 'Late' })).status).toBe(409);
    expect((await asPim('POST', url, { kind: 'NOTE', body: 'Late' })).status).toBe(409);

    // Nor while it is still a DRAFT.
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Draft',
      description: 'Not sent yet.',
      withChoices: false,
    });
    expect((await asBeam('POST', messagesUrl(draft.id), { kind: 'NOTE', body: 'x' })).status).toBe(
      409,
    );
  });

  test('deciding while NEEDS_INFO is rejected', async () => {
    const request = await open();
    await asPim('POST', messagesUrl(request.id), { kind: 'QUESTION', body: 'Which region?' });
    ai.calls.length = 0;

    const res = await asPim('POST', `/decision-requests/${request.id}/decision`, {
      choiceId: request.choices[0]?.id,
    });
    expect(res.status).toBe(409);
    expect(ai.calls).toHaveLength(0);
    expect(await db.decision.count({ where: { requestId: request.id } })).toBe(0);
    const view = await asPim<DecisionRequestView>('GET', `/decision-requests/${request.id}`);
    expect(view.body.status).toBe('NEEDS_INFO');
  });

  test('either party may add a NOTE without changing state; others may not', async () => {
    const outsider = await person('Dao', ['QA']);
    const request = await open();
    const url = messagesUrl(request.id);

    const pimNote = await asPim<DecisionRequestView>('POST', url, { kind: 'NOTE', body: 'Seen.' });
    expect(pimNote.status).toBe(201);
    expect(pimNote.body.status).toBe('OPEN');

    await asPim('POST', url, { kind: 'QUESTION', body: 'Cost?' });
    const beamNote = await asBeam<DecisionRequestView>('POST', url, {
      kind: 'NOTE',
      body: 'Checking with finance.',
    });
    expect(beamNote.status).toBe(201);
    expect(beamNote.body.status).toBe('NEEDS_INFO');
    expect(beamNote.body.messages.map((m) => m.kind)).toEqual(['NOTE', 'QUESTION', 'NOTE']);

    expect((await outsider.call('POST', url, { kind: 'NOTE', body: 'Hi' })).status).toBe(403);
  });

  test('the Raiser may withdraw from NEEDS_INFO', async () => {
    const request = await open();
    await asPim('POST', messagesUrl(request.id), { kind: 'QUESTION', body: 'Still needed?' });
    const res = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${request.id}/withdraw`,
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('WITHDRAWN');
  });

  test('a recipient asking a request nobody has Claimed Claims it', async () => {
    const nok = await person('Nok', ['PO'], ['PO']);
    const request = await open();
    expect(request.decider).toBeNull();

    const asked = await nok.call<DecisionRequestView>('POST', messagesUrl(request.id), {
      kind: 'QUESTION',
      body: 'Which provider?',
    });
    expect(asked.status).toBe(201);
    expect(asked.body.status).toBe('NEEDS_INFO');
    expect(asked.body.decider).toEqual({ id: nok.id, name: 'Nok' });

    // Pim, the other recipient, is not the Decider now.
    expect((await asPim('POST', messagesUrl(request.id), { kind: 'NOTE', body: 'x' })).status).toBe(
      403,
    );
  });

  test('invalid bodies are 400; unknown request is 404', async () => {
    const request = await open();
    const url = messagesUrl(request.id);
    for (const body of [
      {},
      { kind: 'QUESTION' },
      { kind: 'QUESTION', body: '   ' },
      { kind: 'REPLY', body: 'Hi' },
      { kind: 'NOTE', body: 'x'.repeat(10_001) },
    ]) {
      expect((await asPim('POST', url, body)).status).toBe(400);
    }
    expect((await asPim('POST', messagesUrl(UNKNOWN_ID), { kind: 'NOTE', body: 'x' })).status).toBe(
      404,
    );
  });
});
