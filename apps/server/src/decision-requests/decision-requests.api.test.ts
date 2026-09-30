import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { DecisionRequestView, FeatureSummaryView } from '@vorasaan/shared';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

describe('Decision Requests API: raise and submit', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asBeam: ReturnType<typeof as>;
  let asPim: ReturnType<typeof as>;

  const raise = (overrides: object = {}) =>
    asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
      ...overrides,
    });

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

  test('GET /features lists the Features I own a role on', async () => {
    const res = await asBeam<FeatureSummaryView[]>('GET', '/features');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: SEED.featureId,
        title: 'Async checkout',
        teamName: 'Checkout',
        projectName: 'Mobile Banking',
        myRoles: ['BACKEND'],
      },
    ]);
  });

  test('raise → DRAFT with AI Choices and a suggested role', async () => {
    const res = await raise();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.choices).toHaveLength(3);
    expect(res.body.choices.map((c) => c.label)).toEqual(['A', 'B', 'C']);
    expect(res.body.suggestedRole).toBe('PO');
    expect(res.body.raiser).toEqual({ id: beam.id, name: 'Beam' });
    expect(res.body.decider).toBeNull();

    const call = ai.calls[0] as {
      input: { specMarkdown: string; request: { raiserRole: string } };
    };
    expect(call.input.specMarkdown).toContain('# Async checkout');
    expect(call.input.request.raiserRole).toBe('BACKEND');
  });

  test('a plain-text Question skips the AI', async () => {
    const res = await raise({ kind: 'QUESTION', withChoices: false });
    expect(res.status).toBe(201);
    expect(res.body.choices).toEqual([]);
    expect(res.body.suggestedRole).toBeNull();
    expect(ai.calls).toHaveLength(0);
  });

  test('invalid bodies are rejected with 400', async () => {
    expect((await raise({ kind: 'ISSUE' })).status).toBe(400);
    expect((await raise({ title: '' })).status).toBe(400);
  });

  test('only a Role Owner can raise (403); unknown Feature is 404', async () => {
    const outsider = await db.user.create({
      data: { email: 'x@acme.test', name: 'Outsider', passwordHash: 'x' },
    });
    const res = await as(app, outsider.id)('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 't',
      description: 'd',
    });
    expect(res.status).toBe(403);
    expect((await raise({ featureId: crypto.randomUUID() })).status).toBe(404);
  });

  test('submit → OPEN with Pim as the Decider, visible in her Inbox', async () => {
    const { body: draft } = await raise();
    const res = await asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: 'PO',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.decider).toEqual({ id: pim.id, name: 'Pim' });
    expect(res.body.submittedAt).not.toBeNull();

    const inbox = await asPim<DecisionRequestView[]>(
      'GET',
      '/decision-requests?decider=me&status=OPEN',
    );
    expect(inbox.body.map((r) => r.id)).toEqual([draft.id]);
  });

  test('submitting twice, or by someone else, fails', async () => {
    const { body: draft } = await raise();
    const url = `/decision-requests/${draft.id}/submit`;
    expect((await asPim('POST', url, { deciderRole: 'PO' })).status).toBe(403);
    expect((await asBeam('POST', url, { deciderRole: 'PO' })).status).toBe(201);
    expect((await asBeam('POST', url, { deciderRole: 'PO' })).status).toBe(409);
  });

  test('Choices edited at submit are saved and flagged', async () => {
    const { body: draft } = await raise();
    const choices = [
      {
        label: 'A',
        title: 'Poll every 30s',
        description: 'd',
        impactScope: 's',
        impactTime: 't',
        impactRisk: 'r',
      },
      {
        label: 'B',
        title: 'Ask provider for webhooks',
        description: 'd',
        impactScope: 's',
        impactTime: 't',
        impactRisk: 'r',
      },
    ];
    const res = await asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: 'PO',
      choices,
    });
    expect(res.body.choices.map((c) => [c.title, c.editedByUser])).toEqual([
      ['Poll every 30s', true],
      ['Ask provider for webhooks', true],
    ]);
  });

  test('the Decider cannot be the Raiser, and must be unambiguous (422)', async () => {
    const { body: draft } = await raise();
    const url = `/decision-requests/${draft.id}/submit`;
    expect((await asBeam('POST', url, { deciderRole: 'BACKEND' })).status).toBe(422);
    expect((await asBeam('POST', url, { deciderRole: 'TECH_LEAD' })).status).toBe(422);

    const secondPo = await db.user.create({
      data: { email: 'po2@acme.test', name: 'Second PO', passwordHash: 'x' },
    });
    await db.roleOwner.create({
      data: { featureId: SEED.featureId, userId: secondPo.id, role: 'PO' },
    });
    expect((await asBeam('POST', url, { deciderRole: 'PO' })).status).toBe(422);
  });

  test('withdraw works from DRAFT and OPEN, not afterwards', async () => {
    const { body: draft } = await raise();
    const withdrawn = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/withdraw`,
    );
    expect(withdrawn.body.status).toBe('WITHDRAWN');
    expect((await asBeam('POST', `/decision-requests/${draft.id}/withdraw`)).status).toBe(409);

    const { body: second } = await raise();
    await asBeam('POST', `/decision-requests/${second.id}/submit`, { deciderRole: 'PO' });
    expect((await asPim('POST', `/decision-requests/${second.id}/withdraw`)).status).toBe(403);
    const res = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${second.id}/withdraw`,
    );
    expect(res.body.status).toBe('WITHDRAWN');
  });
});
