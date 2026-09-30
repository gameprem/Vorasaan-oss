import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { DecisionRequestView, SpecProposalView, SpecVersionView } from '@vorasaan/shared';
import { AiOutputError, type AttachmentForAi } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { ATTACHMENT_CONTEXT_BUDGET } from '../attachments/attachment-context.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const url = `/features/${SEED.featureId}/spec-proposals/from-attachments`;

describe('Spec Proposal from Attachments', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  async function attach(
    title: string,
    snapshotText: string | null,
    minutesAgo: number,
    summary: string | null = null,
  ) {
    await db.attachment.create({
      data: {
        featureId: SEED.featureId,
        source: 'FILE',
        title,
        snapshotText,
        snapshotAt: snapshotText === null ? null : new Date(Date.now() - minutesAgo * 60_000),
        summary,
        addedById: pim.id,
      },
    });
  }

  async function counts() {
    const [proposals, versions] = await Promise.all([
      db.specProposal.count(),
      db.specVersion.count({ where: { featureId: SEED.featureId } }),
    ]);
    return { proposals, versions };
  }

  function lastInput<T>(method: string): T {
    const call = ai.calls.filter((c) => c.method === method).at(-1);
    if (!call) throw new Error(`expected a ${method} call`);
    return call.input as T;
  }

  beforeAll(async () => {
    ({ app, ai } = await createTestApp());
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
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

  test('with two Attachments the PO gets a proposal, approves it, and gets an AI_SUMMARY Spec Version', async () => {
    await attach('Provider API', 'Webhooks are not supported. Poll at most 5 req/s.', 10, 'short');
    await attach('Kickoff notes', 'Retry must be one tap.', 1);
    const current = await db.specVersion.findFirstOrThrow({
      where: { featureId: SEED.featureId },
      orderBy: { version: 'desc' },
    });

    const res = await asPim<SpecProposalView>('POST', url);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.source).toBe('AI_SUMMARY');
    expect(res.body.approver.id).toBe(pim.id);
    expect(res.body.baseVersion).toBe(current.version);
    expect(res.body.decisionRequestId).toBeNull();

    // Full Snapshots (not summaries), most recent first, plus the current Spec as the base.
    const input = lastInput<{ specMarkdown: string; attachments: AttachmentForAi[] }>(
      'draftSpecFromAttachments',
    );
    expect(input.specMarkdown).toBe(current.markdown);
    expect(input.attachments.map((a) => a.title)).toEqual(['Kickoff notes', 'Provider API']);
    expect(input.attachments[1]?.text).toContain('Poll at most 5 req/s');

    const approved = await asPim<SpecVersionView>('POST', `/spec-proposals/${res.body.id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.version).toBe(current.version + 1);
    expect(approved.body.source).toBe('AI_SUMMARY');
    expect(approved.body.markdown).toContain('- Kickoff notes');
  });

  test('drafts the first Spec Version when the Feature has none', async () => {
    await db.specVersion.deleteMany({ where: { featureId: SEED.featureId } });
    await attach('Brief', 'Build async checkout.', 1);

    const res = await asPim<SpecProposalView>('POST', url);
    expect(res.status).toBe(201);
    expect(res.body.baseVersion).toBeNull();

    const approved = await asPim<SpecVersionView>('POST', `/spec-proposals/${res.body.id}/approve`);
    expect(approved.body.version).toBe(1);
    expect(approved.body.source).toBe('AI_SUMMARY');
  });

  test('a non-PO gets 403 and the AI is never called', async () => {
    await attach('Brief', 'Build async checkout.', 1);
    const before = await counts();
    const res = await asBeam('POST', url);
    expect(res.status).toBe(403);
    expect(ai.calls).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  test('an Admin who is not the PO may ask, like for editing the Spec by hand', async () => {
    await attach('Brief', 'Build async checkout.', 1);
    const admin = await db.user.create({
      data: { email: 'admin@acme.test', name: 'Admin', passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: admin.id, role: 'ADMIN' },
    });
    const res = await as(app, admin.id)<SpecProposalView>('POST', url);
    expect(res.status).toBe(201);
    expect(res.body.approver.id).toBe(admin.id);
  });

  test('a failed AI call writes nothing', async () => {
    await attach('Brief', 'Build async checkout.', 1);
    const before = await counts();
    const original = ai.draftSpecFromAttachments.bind(ai);
    ai.draftSpecFromAttachments = async () => {
      throw new AiOutputError('draft-spec-from-attachments', new Error('bad output'));
    };
    try {
      const res = await asPim('POST', url);
      expect(res.status).toBe(502);
    } finally {
      ai.draftSpecFromAttachments = original;
    }
    expect(await counts()).toEqual(before);
  });

  test('422 when no Attachment has Snapshot text', async () => {
    await attach('Screenshot', null, 1);
    const res = await asPim('POST', url);
    expect(res.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  test('404 for an unknown Feature', async () => {
    const res = await asPim(
      'POST',
      `/features/${crypto.randomUUID()}/spec-proposals/from-attachments`,
    );
    expect(res.status).toBe(404);
  });

  test('Choice generation and Spec Proposal drafting get Attachment context within budget', async () => {
    await attach('Old page', 'o'.repeat(ATTACHMENT_CONTEXT_BUDGET.decisionRequest), 30);
    await attach('Provider API', 'Full Snapshot text.', 10, 'Summary: polling only.');
    await attach('Kickoff notes', 'Retry must be one tap.', 1);

    const { body: raised } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    const choicesInput = lastInput<{ attachments: AttachmentForAi[] }>('generateChoices');
    expect(choicesInput.attachments.map((a) => a.title)).toEqual([
      'Kickoff notes',
      'Provider API',
      'Old page',
    ]);
    // The summary stands in for the Snapshot when there is one.
    expect(choicesInput.attachments[1]?.text).toBe('Summary: polling only.');
    const used = choicesInput.attachments.reduce((n, a) => n + a.text.length, 0);
    expect(used).toBe(ATTACHMENT_CONTEXT_BUDGET.decisionRequest);

    await asBeam('POST', `/decision-requests/${raised.id}/submit`, { deciderRole: 'PO' });
    const choice = raised.choices[0];
    if (!choice) throw new Error('expected a Choice');
    const decided = await asPim('POST', `/decision-requests/${raised.id}/decision`, {
      choiceId: choice.id,
    });
    expect(decided.status).toBe(201);
    const draftInput = lastInput<{ attachments: AttachmentForAi[] }>('draftSpecProposal');
    expect(draftInput.attachments.map((a) => a.title)).toEqual(
      choicesInput.attachments.map((a) => a.title),
    );
  });
});
