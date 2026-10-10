import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecideResult,
  DecisionGraphBranch,
  DecisionGraphView,
  DecisionRequestView,
  SpecVersionView,
} from '@vorasaan/shared';
import { RedraftsService } from '../redrafts/redrafts.service.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const GRAPH = `/features/${SEED.featureId}/decision-graph`;

describe('Decision Graph of a Feature (ticket 0067)', () => {
  let app: NestFastifyApplication;
  let testApp: TestApp;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  // Spec Versions are stamped by Postgres and requests by the app's clock, both real time
  // here: a pause keeps two steps from sharing a millisecond.
  const tick = () => Bun.sleep(3);

  /** Beam raises a request and sends it to the Feature's PO (Pim). */
  async function send(title: string, kind: 'BLOCKER' | 'QUESTION' = 'QUESTION') {
    await tick();
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind,
      title,
      description: 'Seeded for the Decision Graph.',
    });
    const { status, body } = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    expect(status).toBe(201);
    await tick();
    return body;
  }

  async function decide(request: DecisionRequestView, answer?: string) {
    await tick();
    const res = await asPim<DecideResult>(
      'POST',
      `/decision-requests/${request.id}/decision`,
      answer ? { customAnswer: answer } : { choiceId: request.choices[1]?.id },
    );
    expect(res.status).toBe(201);
    await tick();
    return res.body.proposal.id;
  }

  async function approve(proposalId: string) {
    const res = await asPim<SpecVersionView>('POST', `/spec-proposals/${proposalId}/approve`);
    expect(res.status).toBe(201);
    await tick();
    return res.body.version;
  }

  async function editByHand(baseVersion: number) {
    const res = await asPim<SpecVersionView>('POST', `/features/${SEED.featureId}/spec-versions`, {
      markdown: `# Async checkout\n\nEdited by hand after v${baseVersion}.`,
      baseVersion,
    });
    expect(res.status).toBe(201);
    await tick();
    return res.body.version;
  }

  async function revert(version: number, baseVersion: number) {
    const res = await asPim<SpecVersionView>(
      'POST',
      `/features/${SEED.featureId}/spec-versions/${version}/revert`,
      { baseVersion },
    );
    expect(res.status).toBe(201);
    await tick();
    return res.body.version;
  }

  async function graph(call = asBeam) {
    const res = await call<DecisionGraphView>('GET', GRAPH);
    expect(res.status).toBe(200);
    return res.body;
  }

  const branchOf = (view: DecisionGraphView, requestId: string) => {
    const found = view.branches.find((b) => b.requestId === requestId);
    if (!found) throw new Error(`no branch for ${requestId}`);
    return found;
  };

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    testApp.clock.reset();
    await truncateAll(db);
    await seed(db);
  });

  test('branches fork at the version current when sent and merge at the version they produced, across a manual edit and a revert', async () => {
    // v1 (seed) ── A sent ── A merged as v2 ── edited by hand: v3 ── B sent at v3
    //   ── reverted to v1: v4 ── B decided on v4 and merged as v5.
    const a = await send('Webhook or polling?', 'BLOCKER');
    expect(await approve(await decide(a))).toBe(2);
    expect(await editByHand(2)).toBe(3);
    const b = await send('Retry budget', 'QUESTION');
    expect(await revert(1, 3)).toBe(4);
    expect(await approve(await decide(b, 'Three retries, then give up'))).toBe(5);

    const view = await graph();
    expect(view.featureId).toBe(SEED.featureId);
    expect(view.nodes.map((n) => [n.version, n.source, n.revertedFrom])).toEqual([
      [1, 'MANUAL', null],
      [2, 'DECISION', null],
      [3, 'MANUAL', null],
      [4, 'REVERT', 1],
      [5, 'DECISION', null],
    ]);
    expect(view.nodes.map((n) => n.requestId)).toEqual([null, a.id, null, null, b.id]);
    expect(view.nodes[0]?.approvedBy).toEqual({ id: pim.id, name: 'Pim' });

    expect(view.branches.map((x) => x.requestId)).toEqual([a.id, b.id]);
    expect(branchOf(view, a.id)).toMatchObject({
      kind: 'BLOCKER',
      title: 'Webhook or polling?',
      status: 'SPEC_UPDATED',
      state: 'MERGED',
      raiser: { id: beam.id, name: 'Beam' },
      decider: { id: pim.id, name: 'Pim' },
      fromVersion: 1,
      toVersion: 2,
      decision: {
        decidedBy: { id: pim.id, name: 'Pim' },
        choice: { label: 'B' },
        customAnswer: null,
        source: 'WEB',
      },
      redrafts: [],
      responseWindow: null,
      labels: [],
    });
    // B was sent at v3 and merged at v5, though it was decided on the reverted v4.
    expect(branchOf(view, b.id)).toMatchObject({
      state: 'MERGED',
      fromVersion: 3,
      toVersion: 5,
      decision: { choice: null, customAnswer: 'Three retries, then give up' },
    });
    const merged = branchOf(view, b.id);
    expect(merged.endedAt).toBe(view.nodes[4]?.createdAt ?? '');
  });

  test('a request decided without a Spec change is a closed branch with no merge', async () => {
    const request = await send('Keep the old receipt layout?');
    const proposalId = await decide(request);
    const rejected = await asPim('POST', `/spec-proposals/${proposalId}/reject`);
    expect(rejected.status).toBe(201);

    const view = await graph();
    expect(view.nodes.map((n) => n.version)).toEqual([1]);
    const branch = branchOf(view, request.id);
    expect(branch).toMatchObject({
      status: 'DECIDED',
      state: 'CLOSED',
      fromVersion: 1,
      toVersion: null,
      specProposalId: proposalId,
      labels: [],
    });
    expect(branch.endedAt).not.toBeNull();
    expect(view.nodes[0]?.requestId).toBeNull();
  });

  test('open requests are open branches with their state and Response Window labels', async () => {
    const waiting = await send('Which provider?', 'BLOCKER');
    const asked = await send('Do refunds need approval?');
    const answered = await asPim('POST', `/decision-requests/${asked.id}/messages`, {
      kind: 'QUESTION',
      body: 'Up to which amount?',
    });
    expect(answered.status).toBe(201);
    const pending = await send('Show the fee?');
    const proposalId = await decide(pending);
    // Its Spec Proposal was redrafted once after Request changes (ticket 0065).
    const redrafted = await asPim('POST', `/spec-proposals/${proposalId}/request-changes`, {
      feedback: 'Say where the fee shows.',
    });
    expect(redrafted.status).toBe(201);
    const overdue = await send('Escalated already', 'BLOCKER');
    await db.decisionRequest.update({
      where: { id: overdue.id },
      data: { dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000), escalationStep: 2 },
    });
    const withdrawn = await send('Never mind');
    expect((await asBeam('POST', `/decision-requests/${withdrawn.id}/withdraw`)).status).toBe(201);
    // A draft was never sent: it is no branch.
    await asBeam('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Still a draft',
      description: 'Not sent.',
    });

    const view = await graph();
    expect(view.branches.map((b) => b.title)).toEqual([
      'Which provider?',
      'Do refunds need approval?',
      'Show the fee?',
      'Escalated already',
      'Never mind',
    ]);

    const open = branchOf(view, waiting.id);
    expect(open).toMatchObject({
      status: 'OPEN',
      state: 'WAITING',
      fromVersion: 1,
      toVersion: null,
      endedAt: null,
      decision: null,
      // Pim is the Feature's only PO, so the request went straight to Pim.
      decider: { id: pim.id, name: 'Pim' },
      deciderRole: 'PO',
    });
    expect(open.responseWindow?.dueAt).not.toBeNull();
    expect(open.labels).toHaveLength(1);
    expect(open.labels[0]).toMatch(/^due in \d+[mhd]$/);

    // The clock is paused while NEEDS_INFO: no label, but the state says why it waits.
    expect(branchOf(view, asked.id)).toMatchObject({
      status: 'NEEDS_INFO',
      state: 'NEEDS_INFO',
      decider: { id: pim.id, name: 'Pim' },
      responseWindow: { paused: true },
      labels: [],
      endedAt: null,
    });

    const awaiting: DecisionGraphBranch = branchOf(view, pending.id);
    expect(awaiting).toMatchObject({
      status: 'DECIDED',
      state: 'AWAITING_APPROVAL',
      toVersion: null,
      endedAt: null,
      specProposalId: proposalId,
      responseWindow: null,
      labels: [],
    });
    expect(awaiting.redrafts.map((r) => [r.of, r.number])).toEqual([['SPEC_PROPOSAL', 2]]);

    expect(branchOf(view, overdue.id).labels).toEqual(['overdue 2h', 'escalated']);
    expect(branchOf(view, withdrawn.id)).toMatchObject({
      status: 'WITHDRAWN',
      state: 'WITHDRAWN',
      toVersion: null,
      labels: [],
    });
    expect(branchOf(view, withdrawn.id).endedAt).not.toBeNull();
  });

  test('Redrafts of the Choices before sending are marks on the branch too', async () => {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Card or wallet first?',
      description: 'Seeded for the Decision Graph.',
    });
    const redraft = await asBeam('POST', `/decision-requests/${draft.id}/choices/request-changes`, {
      feedback: 'Add a Choice for both at once.',
    });
    expect(redraft.status).toBe(201);
    await asBeam('POST', `/decision-requests/${draft.id}/submit`, { deciderRole: 'PO' });

    const view = await graph();
    expect(branchOf(view, draft.id).redrafts.map((r) => [r.of, r.number])).toEqual([
      ['CHOICES', 2],
    ]);
  });

  test('a Feature without requests has its Spec Versions and no branches', async () => {
    const view = await graph(asPim);
    expect(view.nodes.map((n) => n.version)).toEqual([1]);
    expect(view.branches).toEqual([]);
  });

  test("someone who can't read the Feature gets a 404, as for a Feature that doesn't exist", async () => {
    const other = await db.organization.create({ data: { name: 'Elsewhere' } });
    const outsider = await db.user.create({
      data: { email: 'outsider@elsewhere.test', name: 'Outsider', passwordHash: 'x' },
    });
    await db.orgMembership.create({ data: { organizationId: other.id, userId: outsider.id } });

    const res = await as(app, outsider.id)('GET', GRAPH);
    expect(res.status).toBe(404);
    expect((await asBeam('GET', `/features/${crypto.randomUUID()}/decision-graph`)).status).toBe(
      404,
    );
    expect((await asBeam('GET', '/features/not-an-id/decision-graph')).status).toBe(400);
  });

  test('the graph is read in a fixed number of queries, however many requests there are', async () => {
    const count = async () => {
      // Background work (indexing, Redrafts, Receipts and the feedback check they start,
      // ticket 0072) would be counted too: let it finish first.
      await testApp.drainIndexing();
      await app.get(RedraftsService).drain();
      await testApp.proposals.drain();
      const { result, sql } = await testApp.recordQueries(() => asBeam('GET', GRAPH));
      expect(result.status).toBe(200);
      // Who is asking, then the Feature, its versions, its requests and their Redrafts.
      return sql.filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;
    };
    const one = await send('First');
    await approve(await decide(one));
    const few = await count();

    for (const title of ['Second', 'Third', 'Fourth']) {
      const request = await send(title, 'BLOCKER');
      const proposalId = await decide(request);
      await asPim('POST', `/spec-proposals/${proposalId}/request-changes`, { feedback: 'More.' });
    }
    await send('Fifth');
    const many = await count();

    expect(many).toBe(few);
    // Prisma reads each relation in one more query, whatever the number of rows.
    expect(few).toBeLessThanOrEqual(15);
  });
});
