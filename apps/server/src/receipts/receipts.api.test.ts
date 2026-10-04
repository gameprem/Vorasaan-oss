import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, Receipt, ReceiptOutcome } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import {
  type ActionCardView,
  type ConversationView,
  type DecideResult,
  type DecisionRequestView,
  diffLines,
  type FeatureSuggestionView,
  RECEIPT_EXPORT_FORMAT,
  ReceiptExportLine,
  type ReceiptSettingsView,
  type SpecProposalView,
  type SpecVersionView,
} from '@vorasaan/shared';
import { skillVersion } from '@vorasaan/skills';
import type { ChatChunk } from '../ai/ai.port.ts';
import { FAKE_USAGE, type FakeAiPort } from '../ai/fake-ai.port.ts';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import type { ReceiptsService } from './receipts.service.ts';

const { pim, beam } = SEED.users;
const DAY = 24 * 60 * 60 * 1000;

const call = (id: string, name: string, args: unknown): ChatChunk => ({
  type: 'tool-call',
  call: { id, name, args },
});
const text = (delta: string): ChatChunk => ({ type: 'text', delta });

describe('Receipts and their outcomes (ticket 0070)', () => {
  let test_: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let receipts: ReceiptsService;
  const asPim = () => as(app, pim.id);
  const asBeam = () => as(app, beam.id);

  /** The Receipts written so far, oldest first, once every write has landed. */
  async function stored(): Promise<(Receipt & { outcomes: ReceiptOutcome[] })[]> {
    await test_.drainIndexing();
    await receipts.drain();
    return db.receipt.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { outcomes: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** The export, as its JSONL lines parsed. */
  async function exported(userId: string = pim.id) {
    await receipts.drain();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/ai/receipts/export',
      headers: { [DEV_USER_HEADER]: userId },
    });
    return { res, lines: res.body.split('\n').filter(Boolean) };
  }

  /** Beam raises a Blocker and sends it to Pim, who decides Choice B: a pending Spec Proposal. */
  async function decidedProposal(): Promise<DecideResult> {
    const { body: draft } = await asBeam()<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    const { body: open } = await asBeam()<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    const choice = open.choices[1];
    if (!choice) throw new Error('expected a Choice B');
    const { body } = await asPim()<DecideResult>('POST', `/decision-requests/${open.id}/decision`, {
      choiceId: choice.id,
    });
    return body;
  }

  beforeAll(async () => {
    test_ = await createTestApp();
    ({ app, ai, receipts } = test_);
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    ai.chatScript.length = 0;
    test_.clock.reset();
  });

  test("raising a Decision Request writes a Receipt for its Choices, with the fake's usage", async () => {
    const res = await asBeam()<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    expect(res.status).toBe(201);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    const model = ai.calls[0]?.model;
    expect(rows[0]).toMatchObject({
      task: 'generateChoices',
      taskKind: 'CHOICES',
      promptName: 'generate-choices',
      promptVersion: await skillVersion('generate-choices'),
      modelSource: model?.source,
      modelName: model?.provider?.model ?? model?.name,
      language: 'en',
      ...FAKE_USAGE,
      success: true,
      outputKind: 'CHOICES',
      outputId: res.body.id,
      proposalKind: 'CHOICES',
      proposalId: res.body.id,
      redraft: 1,
      requestedById: beam.id,
    });
    expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('Request changes twice, then Approve: Approve after 2 Redrafts, with both feedback texts', async () => {
    const { proposal } = await decidedProposal();
    for (const feedback of ['Mention the retry limit', 'Shorter, please']) {
      const res = await asPim()('POST', `/spec-proposals/${proposal.id}/request-changes`, {
        feedback,
      });
      expect(res.status).toBe(201);
    }
    const approved = await asPim()<SpecVersionView>(
      'POST',
      `/spec-proposals/${proposal.id}/approve`,
      { redraft: 3 },
    );
    expect(approved.status).toBe(201);

    const rows = await stored();
    const drafted = rows.find((r) => r.task === 'draftSpecProposal');
    expect(drafted).toMatchObject({
      proposalKind: 'SPEC_PROPOSAL',
      proposalId: proposal.id,
      redraft: 1,
      outputKind: 'SPEC_PROPOSAL',
      outputId: proposal.id,
      requestedById: pim.id,
    });
    expect(drafted?.outcomes.map((o) => [o.kind, o.redraft, o.reason])).toEqual([
      ['REQUEST_CHANGES', 1, 'Mention the retry limit'],
      ['REQUEST_CHANGES', 2, 'Shorter, please'],
      ['APPROVE', 3, null],
    ]);
    expect(drafted?.outcomes.at(-1)).toMatchObject({ redraftsBeforeApproval: 2, actorId: pim.id });

    // Each Redraft has its own Receipt, pointing at the Redraft it wrote.
    const redrafts = rows.filter((r) => r.task === 'redraftSpecProposal');
    expect(redrafts.map((r) => r.redraft)).toEqual([2, 3]);
    const written = await db.redraft.findMany({
      where: { proposalId: proposal.id, number: { gt: 1 } },
      orderBy: { number: 'asc' },
    });
    expect(redrafts.map((r) => r.outputId)).toEqual(written.map((r) => r.id));
    const approval = drafted?.outcomes.at(-1);
    expect(approval?.redraftReceiptId).toBe(redrafts[1]?.id ?? '');

    // The export shows the same on the drafting Receipt's line, and parses.
    const { lines } = await exported();
    const line = lines
      .map((l) => ReceiptExportLine.parse(JSON.parse(l)))
      .find((l) => l.id === drafted?.id);
    expect(line?.outcomes.map((o) => o.kind)).toEqual([
      'REQUEST_CHANGES',
      'REQUEST_CHANGES',
      'APPROVE',
    ]);
    expect(line?.outcomes.at(-1)?.redraftsBeforeApproval).toBe(2);
    expect(line?.outcomes.map((o) => o.text)).toEqual([
      'Mention the retry limit',
      'Shorter, please',
      null,
    ]);
  });

  test('a Decline with its reason, and a hand edit of the Spec after approval, are linked', async () => {
    const first = await decidedProposal();
    const declined = await asPim()<SpecProposalView>(
      'POST',
      `/spec-proposals/${first.proposal.id}/reject`,
      { reason: 'It drops the polling interval' },
    );
    expect(declined.status).toBe(201);

    // A second Decision Request, decided and approved, then the Spec edited by hand.
    const second = await decidedProposal();
    const approved = await asPim()<SpecVersionView>(
      'POST',
      `/spec-proposals/${second.proposal.id}/approve`,
    );
    expect(approved.body.version).toBe(2);
    const edited = await asPim()<SpecVersionView>(
      'POST',
      `/features/${SEED.featureId}/spec-versions`,
      {
        baseVersion: 2,
        markdown: `${approved.body.markdown}\n\n## Note\n- Added by hand.\n`,
      },
    );
    expect(edited.status).toBe(201);
    // A later hand edit is outside the window: only the one right after approval counts.
    await asPim()('POST', `/features/${SEED.featureId}/spec-versions`, {
      baseVersion: 3,
      markdown: `${SEED_SPEC_V1}\n`,
    });

    const rows = await stored();
    const byProposal = (id: string) =>
      rows.find((r) => r.task === 'draftSpecProposal' && r.proposalId === id);
    expect(byProposal(first.proposal.id)?.outcomes).toMatchObject([
      { kind: 'DECLINE', reason: 'It drops the polling interval', redraft: 1, actorId: pim.id },
    ]);
    const outcomes = byProposal(second.proposal.id)?.outcomes ?? [];
    expect(outcomes.map((o) => o.kind)).toEqual(['APPROVE', 'MANUAL_EDIT']);
    const changed = diffLines(approved.body.markdown, edited.body.markdown).filter(
      (l) => l.kind !== 'UNCHANGED',
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(outcomes[1]?.editSize).toBe(changed.length);
    expect(outcomes[0]?.redraftsBeforeApproval).toBe(0);

    // Deciding a Choice approves the Choices; their Receipt says which.
    const choices = rows.filter((r) => r.task === 'generateChoices');
    expect(choices).toHaveLength(2);
    for (const r of choices) {
      expect(r.outcomes).toMatchObject([{ kind: 'APPROVE', choiceLabel: 'B', actorId: pim.id }]);
    }
  });

  test('a Feature Suggestion dismissed with a reason links to the batch that suggested it', async () => {
    const res = await asPim()<FeatureSuggestionView[]>(
      'POST',
      `/projects/${SEED.projectId}/feature-suggestions/generate`,
      { count: 2 },
    );
    expect(res.status).toBe(201);
    const [first] = res.body;
    if (!first) throw new Error('expected a suggestion');
    const dismissed = await asPim()('POST', `/feature-suggestions/${first.id}/dismiss`, {
      reason: 'We have this already',
    });
    expect(dismissed.status).toBe(201);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: 'suggestFeatures',
      outputKind: 'FEATURE_SUGGESTION_BATCH',
      outputId: (await db.featureSuggestion.findUniqueOrThrow({ where: { id: first.id } })).batchId,
    });
    expect(rows[0]?.outcomes).toMatchObject([
      { kind: 'DECLINE', proposalId: first.id, reason: 'We have this already' },
    ]);
  });

  test('a proposal drafted in a Conversation links its outcome to the reply that drafted it', async () => {
    ai.scriptChat(
      {
        chunks: [
          text('Drafting. '),
          call('call-1', 'draftSpecProposal', {
            proposedMarkdown: `${SEED_SPEC_V1.trimEnd()}\n\n## Timeouts\n- 24 hours.\n`,
            summary: 'Adds a timeout.',
          }),
        ],
      },
      { chunks: [text('Ready.')] },
    );
    const conv = await asPim()<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content: 'Add a timeout',
    });
    const card = conv.body.actionCards[0] as ActionCardView;
    const declined = await asPim()('POST', `/action-cards/${card.id}/decline`, {
      reason: 'Not now',
    });
    expect(declined.status).toBe(201);

    const rows = await stored();
    const chats = rows.filter((r) => r.task === 'chat');
    expect(chats).toHaveLength(2);
    const drafting = chats.find((r) => r.outputId === card.messageId);
    expect(drafting?.outcomes).toMatchObject([
      {
        kind: 'DECLINE',
        proposalKind: 'SPEC_PROPOSAL',
        proposalId: card.targetId,
        reason: 'Not now',
      },
    ]);
  });

  test('the export holds no name, email or Attachment content; every line parses', async () => {
    const secretText = 'CONFIDENTIAL-ATTACHMENT-TEXT: the vault code is 1234';
    const scan = await asPim()('POST', `/projects/${SEED.projectId}/repo-scans`, {
      markdown: `# Repo Scan\n\n${secretText}\n`,
      repoName: 'acme/mobile-bank',
    });
    expect(scan.status).toBe(201);
    const { proposal } = await decidedProposal();
    await asPim()('POST', `/spec-proposals/${proposal.id}/request-changes`, {
      feedback: 'Ask Beam (beam@acme.test) and Pim first',
    });
    await asPim()('POST', `/spec-proposals/${proposal.id}/reject`, {
      reason: 'Pim says no; write to someone@example.com',
    });

    const { res, lines } = await exported();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const body = res.body;
    for (const forbidden of [
      'Pim',
      'Beam',
      'pim@acme.test',
      'beam@acme.test',
      'someone@example.com',
      pim.id,
      beam.id,
      'CONFIDENTIAL-ATTACHMENT-TEXT',
      'vault code',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    const parsed = lines.map((l) => ReceiptExportLine.parse(JSON.parse(l)));
    expect(parsed.every((l) => l.format === RECEIPT_EXPORT_FORMAT)).toBe(true);
    expect(parsed.map((l) => l.task).sort()).toEqual([
      'draftSpecProposal',
      'generateChoices',
      'redraftSpecProposal',
      'summarizeAttachment',
    ]);
    // People are stable ids within the export, and names in free text become those ids.
    const draft = parsed.find((l) => l.task === 'draftSpecProposal');
    const pimId = draft?.requestedBy;
    expect(pimId).toMatch(/^person-\d+$/);
    expect(draft?.outcomes.every((o) => o.by === pimId)).toBe(true);
    const feedback = draft?.outcomes.find((o) => o.kind === 'REQUEST_CHANGES')?.text ?? '';
    expect(feedback).toContain(`and ${pimId} first`);
    expect(feedback).toMatch(/^Ask person-\d+ \(person-\d+\)/);
    expect(draft?.outcomes.find((o) => o.kind === 'DECLINE')?.text).toBe(
      `${pimId} says no; write to [email]`,
    );
  });

  test('with collection off nothing is written; past retention the job deletes Receipts and outcomes', async () => {
    const off = await asPim()<ReceiptSettingsView>('PUT', '/settings/ai/receipts', {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, retentionDays: 90, count: 0 });
    await decidedProposal();
    expect(await stored()).toHaveLength(0);

    await asPim()('PUT', '/settings/ai/receipts', { enabled: true, retentionDays: 7 });
    test_.clock.set('2026-10-01T09:00:00.000Z');
    const { proposal } = await decidedProposal();
    await asPim()('POST', `/spec-proposals/${proposal.id}/reject`, { reason: 'No' });
    expect(await stored()).toHaveLength(2);
    expect(await db.receiptOutcome.count()).toBe(2); // the Choices approved, the draft declined

    test_.clock.set('2026-10-06T09:00:00.000Z');
    await asBeam()('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Later one',
      description: 'Kept.',
    });
    await receipts.drain();
    const view = await asPim()<ReceiptSettingsView>('GET', '/settings/ai/receipts');
    expect(view.body).toMatchObject({ enabled: true, retentionDays: 7, count: 3 });
    expect(view.body.oldestAt).toBe('2026-10-01T09:00:00.000Z');

    test_.clock.set(new Date(Date.parse('2026-10-01T09:00:00.000Z') + 7 * DAY + 1));
    expect(await receipts.purge()).toEqual({ receipts: 2, outcomes: 2 });
    const left = await stored();
    expect(left.map((r) => r.createdAt.toISOString())).toEqual(['2026-10-06T09:00:00.000Z']);
  });

  test('a Receipt write that fails never fails the person’s action', async () => {
    const original = (receipts as unknown as { persist: unknown }).persist;
    (receipts as unknown as { persist: () => Promise<never> }).persist = () =>
      Promise.reject(new Error('database is down'));
    try {
      const res = await asBeam()<DecisionRequestView>('POST', '/decision-requests', {
        featureId: SEED.featureId,
        kind: 'BLOCKER',
        title: 'Provider has no webhook',
        description: 'Only polling is available.',
      });
      expect(res.status).toBe(201);
      expect(res.body.choices).toHaveLength(3);
      expect(await stored()).toHaveLength(0);
    } finally {
      (receipts as unknown as { persist: unknown }).persist = original;
    }
  });

  test('only an Admin reads, changes or exports Receipts', async () => {
    expect((await asBeam()('GET', '/settings/ai/receipts')).status).toBe(403);
    expect((await asBeam()('PUT', '/settings/ai/receipts', { enabled: false })).status).toBe(403);
    expect((await exported(beam.id)).res.statusCode).toBe(403);
    expect((await asPim()('GET', '/settings/ai/receipts')).status).toBe(200);
    expect((await asPim()('PUT', '/settings/ai/receipts', {})).status).toBe(400);
    expect((await asPim()('PUT', '/settings/ai/receipts', { retentionDays: 0 })).status).toBe(400);
    expect((await exported()).res.statusCode).toBe(200);
    expect((await db.organization.findFirstOrThrow()).receiptsEnabled).toBe(true);
  });

  test('the Redraft eval cases (0065) are still exported', async () => {
    const { proposal } = await decidedProposal();
    await asPim()('POST', `/spec-proposals/${proposal.id}/request-changes`, {
      feedback: 'Shorter',
    });
    const res = await asPim()<unknown[]>('GET', '/redrafts/eval-cases');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
