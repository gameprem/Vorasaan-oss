import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecideResult,
  DecisionLogEntry,
  DecisionRequestView,
  SpecProposalView,
  SpecVersionView,
} from '@vorasaan/shared';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

describe('Decide, Spec Proposal, approve', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asBeam: ReturnType<typeof as>;
  let asPim: ReturnType<typeof as>;

  /** Beam raises a Blocker and submits it to Pim. */
  async function openRequest(withChoices = true): Promise<DecisionRequestView> {
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: withChoices ? 'BLOCKER' : 'QUESTION',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
      withChoices,
    });
    const { body } = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    return body;
  }

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

  test('full path: decide Choice B → approve → Spec v2 linked in the Decision Log', async () => {
    const request = await openRequest();
    const choiceB = request.choices[1];
    if (!choiceB) throw new Error('expected a Choice B');

    const decided = await asPim<DecideResult>('POST', `/decision-requests/${request.id}/decision`, {
      choiceId: choiceB.id,
      rationale: 'Cheapest option',
    });
    expect(decided.status).toBe(201);
    expect(decided.body.request.status).toBe('DECIDED');
    expect(decided.body.request.decision?.choiceId).toBe(choiceB.id);
    expect(decided.body.proposal.status).toBe('PENDING');
    expect(decided.body.proposal.baseVersion).toBe(1);
    expect(decided.body.proposal.baseMarkdown).toContain('# Async checkout');
    expect(decided.body.proposal.proposedMarkdown).toContain('Picked Choice B');

    const proposal = await asPim<SpecProposalView>(
      'GET',
      `/spec-proposals/${decided.body.proposal.id}`,
    );
    expect(proposal.body.decisionRequestId).toBe(request.id);

    const approved = await asPim<SpecVersionView>(
      'POST',
      `/spec-proposals/${decided.body.proposal.id}/approve`,
    );
    expect(approved.status).toBe(201);
    expect(approved.body.version).toBe(2);
    expect(approved.body.source).toBe('DECISION');
    expect(approved.body.approvedBy).toEqual({ id: pim.id, name: 'Pim' });

    const after = await asPim<DecisionRequestView>('GET', `/decision-requests/${request.id}`);
    expect(after.body.status).toBe('SPEC_UPDATED');
    expect(after.body.specProposal).toEqual({ id: decided.body.proposal.id, status: 'APPROVED' });

    const versions = await asBeam<SpecVersionView[]>(
      'GET',
      `/features/${SEED.featureId}/spec-versions`,
    );
    expect(versions.body.map((v) => v.version)).toEqual([2, 1]);

    const log = await asBeam<DecisionLogEntry[]>('GET', `/features/${SEED.featureId}/decision-log`);
    expect(log.body).toHaveLength(1);
    expect(log.body[0]).toMatchObject({
      decisionRequestId: request.id,
      choice: { label: 'B' },
      rationale: 'Cheapest option',
      specVersion: 2,
      decidedBy: { id: pim.id, name: 'Pim' },
    });
  });

  test('a custom answer works the same way, including for a plain-text Question', async () => {
    const request = await openRequest(false);
    const decided = await asPim<DecideResult>('POST', `/decision-requests/${request.id}/decision`, {
      customAnswer: 'Poll every 30 seconds for now',
    });
    expect(decided.status).toBe(201);
    expect(decided.body.proposal.proposedMarkdown).toContain('Poll every 30 seconds');

    await asPim('POST', `/spec-proposals/${decided.body.proposal.id}/approve`);
    const log = await asPim<DecisionLogEntry[]>('GET', `/features/${SEED.featureId}/decision-log`);
    expect(log.body[0]).toMatchObject({
      choice: null,
      customAnswer: 'Poll every 30 seconds for now',
      specVersion: 2,
    });
  });

  test('only the Decider can decide; only OPEN requests; the Choice must belong', async () => {
    const request = await openRequest();
    const url = `/decision-requests/${request.id}/decision`;
    const choiceId = request.choices[0]?.id;

    expect((await asBeam('POST', url, { choiceId })).status).toBe(403);
    expect((await asPim('POST', url, { choiceId: crypto.randomUUID() })).status).toBe(422);
    expect((await asPim('POST', url, { choiceId, customAnswer: 'both' })).status).toBe(400);
    expect((await asPim('POST', url, { choiceId })).status).toBe(201);
    expect((await asPim('POST', url, { choiceId })).status).toBe(409);
  });

  test('only the approver can approve or reject; reject keeps the Decision', async () => {
    const request = await openRequest();
    const { body } = await asPim<DecideResult>(
      'POST',
      `/decision-requests/${request.id}/decision`,
      {
        choiceId: request.choices[0]?.id,
      },
    );
    const proposalUrl = `/spec-proposals/${body.proposal.id}`;

    expect((await asBeam('POST', `${proposalUrl}/approve`)).status).toBe(403);
    expect((await asBeam('POST', `${proposalUrl}/reject`)).status).toBe(403);

    const rejected = await asPim<SpecProposalView>('POST', `${proposalUrl}/reject`);
    expect(rejected.body.status).toBe('REJECTED');
    expect((await asPim('POST', `${proposalUrl}/approve`)).status).toBe(409);

    const after = await asPim<DecisionRequestView>('GET', `/decision-requests/${request.id}`);
    expect(after.body.status).toBe('DECIDED');
    expect(await db.specVersion.count()).toBe(1);
  });

  test('approving a stale proposal is 409 and writes nothing', async () => {
    const request = await openRequest();
    const { body } = await asPim<DecideResult>(
      'POST',
      `/decision-requests/${request.id}/decision`,
      {
        choiceId: request.choices[0]?.id,
      },
    );

    // Someone else moved the Spec on after the proposal was drafted.
    await db.specVersion.create({
      data: {
        featureId: SEED.featureId,
        version: 2,
        markdown: '# Edited meanwhile',
        source: 'MANUAL',
        approvedById: pim.id,
      },
    });

    const res = await asPim('POST', `/spec-proposals/${body.proposal.id}/approve`);
    expect(res.status).toBe(409);
    expect(await db.specVersion.count()).toBe(2);
    const proposal = await db.specProposal.findUniqueOrThrow({ where: { id: body.proposal.id } });
    expect(proposal.status).toBe('PENDING');
  });

  test('approve is atomic: a failure after the version is written rolls it back', async () => {
    const request = await openRequest();
    const { body } = await asPim<DecideResult>(
      'POST',
      `/decision-requests/${request.id}/decision`,
      {
        choiceId: request.choices[0]?.id,
      },
    );

    // The request leaves DECIDED concurrently, so the last step of approve fails.
    await db.decisionRequest.update({ where: { id: request.id }, data: { status: 'WITHDRAWN' } });

    const res = await asPim('POST', `/spec-proposals/${body.proposal.id}/approve`);
    expect(res.status).toBe(409);
    expect(await db.specVersion.count()).toBe(1);
    const proposal = await db.specProposal.findUniqueOrThrow({ where: { id: body.proposal.id } });
    expect(proposal.status).toBe('PENDING');
  });

  test('a failed AI draft writes nothing, so the Decider can retry', async () => {
    const request = await openRequest();
    const original = ai.draftSpecProposal.bind(ai);
    const { AiOutputError } = await import('../ai/ai.port.ts');
    ai.draftSpecProposal = async () => {
      throw new AiOutputError('draft-spec-proposal', new Error('bad output'));
    };
    try {
      const res = await asPim('POST', `/decision-requests/${request.id}/decision`, {
        choiceId: request.choices[0]?.id,
      });
      expect(res.status).toBe(502);
      expect(await db.decision.count()).toBe(0);
      const after = await db.decisionRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(after.status).toBe('OPEN');
    } finally {
      ai.draftSpecProposal = original;
    }
  });
});
