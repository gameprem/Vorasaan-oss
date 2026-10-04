import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiProviderView,
  ApprovedModelSettingsView,
  DecisionRequestView,
  PromptAnalysisView,
  PromptDetailView,
  PromptProposalView,
  PromptsView,
  PromptVersionView,
  ProposalRedraftsView,
  RequestChangesResult,
} from '@vorasaan/shared';
import { promptVersionOf, readSkillSource } from '@vorasaan/skills';
import { AI_TASKS, type AiTask } from '../ai/ai.config.ts';
import { type FakeAiPort, fakeGuidance } from '../ai/fake-ai.port.ts';
import { casesForPrompt } from '../evals/eval-sets.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { PromptVersionsService } from './prompt-versions.service.ts';

// Ticket 0072: the AI reads a prompt's feedback, names its patterns and proposes a Prompt
// Version; evals run on it and on the active version; only an Admin's Approve uses it.

const { pim, beam } = SEED.users;
const BASE = '/settings/ai/prompts';
const CHOICES = `${BASE}/generate-choices`;
const SHORTER = 'Shorter please: each Choice is far too long to read on a phone.';

describe('the AI proposes better prompts (ticket 0072)', () => {
  let test_: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let prompts: PromptVersionsService;
  const asPim = () => as(app, pim.id);
  const asBeam = () => as(app, beam.id);

  /** Beam raises a Blocker: its Choices are generated, leaving the Receipt outcomes link to. */
  async function raise(title = 'Provider has no webhook'): Promise<DecisionRequestView> {
    const res = await asBeam()<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title,
      description: 'Only polling is available.',
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  /**
   * `count` scripted outcomes on the Choices of one Decision Request: Request changes with
   * `text`, each linked to the Receipt of the call that drafted them, as people would leave.
   */
  async function script(
    count: number,
    text = SHORTER,
    kind: 'REQUEST_CHANGES' | 'DECLINE' = 'REQUEST_CHANGES',
  ) {
    const request = await raise(`Scripted ${text.slice(0, 20)} ${count}`);
    await test_.receipts.drain();
    for (let i = 0; i < count; i++) {
      test_.receipts.outcome({
        kind,
        proposal: { kind: 'CHOICES', id: request.id },
        actorId: beam.id,
        redraft: 1,
        reason: text,
      });
    }
    await test_.proposals.drain();
    return request;
  }

  async function approvedModel(): Promise<ApprovedModelSettingsView> {
    const provider = await asPim()<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: 'sk-ant-test-1234',
    });
    expect(provider.status).toBe(201);
    const model = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.body.id,
      modelId: 'model-eval',
      displayName: 'Eval',
    });
    expect(model.status).toBe(201);
    return model.body;
  }

  async function setAnalysisAfter(analysisAfter: number) {
    const res = await asPim()('PUT', '/settings/ai/prompt-analysis', { analysisAfter });
    expect(res.status).toBe(200);
  }

  /** Pim asks the AI to read the Choices prompt's feedback; returns the analysis once done. */
  async function analyze(): Promise<PromptAnalysisView> {
    const started = await asPim()<PromptAnalysisView>('POST', `${CHOICES}/analyses`);
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ status: 'RUNNING', trigger: 'MANUAL' });
    await test_.proposals.drain();
    const detail = await asPim()<PromptDetailView>('GET', CHOICES);
    const done = detail.body.feedback.analyses.find((a) => a.id === started.body.id);
    if (!done) throw new Error('the analysis is not listed');
    return done;
  }

  async function proposal(number = 1): Promise<PromptProposalView> {
    await test_.proposals.drain();
    const res = await asPim()<PromptProposalView>('GET', `${CHOICES}/versions/${number}/proposal`);
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    test_ = await createTestApp();
    ({ app, ai } = test_);
    prompts = app.get(PromptVersionsService);
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
    ai.failures.length = 0;
    ai.redraftScript.length = 0;
    test_.clock.reset();
  });

  // ─── Analysis and proposal ────────────────────────────────────────────────

  test('with 20 "shorter please" outcomes on Choices, the analysis names the pattern and a version is proposed with a rationale', async () => {
    await approvedModel();
    await setAnalysisAfter(0);
    const request = await script(20);
    // Nothing was read on its own: the Admin turned that off.
    expect(await db.promptAnalysis.count()).toBe(0);

    const analysis = await analyze();
    expect(analysis).toMatchObject({ status: 'DONE', outcomes: 20, proposed: 1, error: null });
    expect(analysis.requestedBy).toEqual({ id: pim.id, name: pim.name });
    const [pattern] = analysis.patterns;
    expect(pattern?.title).toContain('shorter');
    expect(pattern?.count).toBe(20);
    expect(pattern?.cases).toHaveLength(20);
    expect(pattern?.cases[0]).toMatchObject({
      kind: 'REQUEST_CHANGES',
      text: SHORTER,
      redraft: 1,
      proposal: { kind: 'CHOICES', id: request.id },
      href: `/requests/${request.id}`,
    });

    // The AI read every outcome, as numbered cases, with the prompt as it is now.
    const read = ai.calls.find((c) => c.method === 'analyzeFeedback')?.input as {
      template: string;
      cases: { index: number; text: string | null }[];
    };
    expect(read.cases).toHaveLength(20);
    expect(read.cases[0]).toMatchObject({ index: 1, text: SHORTER });
    expect(read.template).toBe(await readSkillSource('generate-choices'));

    // The proposal: a Prompt Version of the default, waiting, with nobody as its writer.
    const detail = await asPim()<PromptDetailView>('GET', CHOICES);
    const v1 = detail.body.versions.find((v) => v.number === 1) as PromptVersionView;
    expect(v1).toMatchObject({
      status: 'PROPOSED',
      analysisId: analysis.id,
      proposedBy: null,
      active: false,
    });
    expect(v1.rationale).toContain('shorter');
    expect(v1.template).toContain(fakeGuidance(pattern?.title ?? ''));
    expect(v1.template.startsWith((await readSkillSource('generate-choices')).trimEnd())).toBe(
      true,
    );
    expect(detail.body.feedback).toMatchObject({ newOutcomes: 0, outcomes: 20, analysisAfter: 0 });

    // Both calls left their Receipt: the analysis, and the proposal it drafted (Redraft 1).
    await test_.receipts.drain();
    const analysed = await db.receipt.findFirstOrThrow({ where: { task: 'analyzeFeedback' } });
    expect(analysed).toMatchObject({
      promptName: 'analyze-feedback',
      taskKind: 'PROMPT_PROPOSALS',
      outputKind: 'PROMPT_ANALYSIS',
      outputId: analysis.id,
      requestedById: pim.id,
    });
    const drafted = await db.receipt.findFirstOrThrow({ where: { task: 'proposePromptVersion' } });
    expect(drafted).toMatchObject({
      outputKind: 'PROMPT_VERSION',
      outputId: v1.id,
      proposalKind: 'PROMPT_VERSION',
      proposalId: v1.id,
      redraft: 1,
    });
  });

  test("people's words are never copied into an analysis: past retention, only the pattern stays", async () => {
    await setAnalysisAfter(0);
    test_.clock.set('2026-10-01T09:00:00.000Z');
    await script(3);
    const analysis = await analyze();
    const stored = await db.promptAnalysis.findUniqueOrThrow({ where: { id: analysis.id } });
    expect(JSON.stringify(stored.patterns)).not.toContain(SHORTER);
    expect(analysis.patterns[0]?.cases[0]?.text).toBe(SHORTER);

    test_.clock.set('2027-03-01T09:00:00.000Z');
    await test_.receipts.purge();
    const detail = await asPim()<PromptDetailView>('GET', CHOICES);
    const [pattern] = detail.body.feedback.analyses[0]?.patterns ?? [];
    expect(pattern?.count).toBe(3);
    expect(pattern?.cases.map((c) => c.text)).toEqual([null, null, null]);
  });

  test('Thai feedback is read too, and a pattern needs at least two cases', async () => {
    await setAnalysisAfter(0);
    await script(3, 'ช่วยเขียนให้สั้นลงหน่อย ยาวเกินไป');
    await script(1, 'Missing the error cases.');
    const analysis = await analyze();
    expect(analysis.patterns.map((p) => [p.title, p.count])).toEqual([
      ['Often asked to be shorter', 3],
    ]);
    expect(analysis.patterns[0]?.cases[0]?.text).toBe('ช่วยเขียนให้สั้นลงหน่อย ยาวเกินไป');
  });

  test('no pattern: the analysis is done and nothing is proposed', async () => {
    await setAnalysisAfter(0);
    await script(4, 'Looks fine.');
    const analysis = await analyze();
    expect(analysis).toMatchObject({ status: 'DONE', patterns: [], proposed: null });
    expect(await db.promptVersion.count()).toBe(0);
  });

  test('no feedback yet is a 422; a failed AI call fails the analysis and proposes nothing', async () => {
    const none = await asPim()('POST', `${CHOICES}/analyses`);
    expect(none.status).toBe(422);

    await setAnalysisAfter(0);
    await script(3);
    ai.failures.push(new Error('provider down for sk-ant-secret-1234567890'));
    const analysis = await analyze();
    expect(analysis.status).toBe('FAILED');
    expect(analysis.error).toContain('provider down');
    expect(await db.promptVersion.count()).toBe(0);
  });

  // ─── Evals ────────────────────────────────────────────────────────────────

  test('evals run on the proposal and on the active version, with scores and sample outputs side by side', async () => {
    const model = await approvedModel();
    await setAnalysisAfter(0);
    await script(20);
    await analyze();

    const view = await proposal(1);
    expect(view.evalsNote).toBeNull();
    expect(view.before).toMatchObject({ number: 0, status: 'DONE', sources: ['CHECKED_IN'] });
    expect(view.after).toMatchObject({ number: 1, status: 'DONE', sources: ['CHECKED_IN'] });
    expect(view.after?.model.approvedModelId).toBe(model.id);
    expect(view.before?.startedBy).toEqual({ id: pim.id, name: pim.name });
    expect(view.before?.score).toEqual(expect.any(Number));
    expect(view.after?.score).toEqual(expect.any(Number));
    const cases = casesForPrompt('generate-choices').length;
    expect(view.after?.total).toBe(cases);
    expect(view.comparison?.cases).toHaveLength(cases);
    const sample = view.comparison?.cases[0];
    expect(sample?.a?.output).toBeTruthy();
    expect(sample?.b?.output).toBeTruthy();
    // The diff from the version it was evaluated against: the guidance added.
    expect(view.activeNumber).toBe(0);
    expect(view.diff).toMatchObject({ from: 0, to: 1, removed: 0 });
    expect(view.diff.lines.some((l) => l.kind === 'ADDED' && l.text.includes('shorter'))).toBe(
      true,
    );
    expect(view.analysis?.patterns[0]?.count).toBe(20);

    // The proposal's calls ran on the version under evaluation; the product's on the default.
    const evalCalls = ai.calls.filter((c) => c.method === 'generateChoices');
    expect(evalCalls.filter((c) => c.prompt?.number === 1)).toHaveLength(cases);
    expect(evalCalls.filter((c) => c.prompt?.number === 0).length).toBeGreaterThanOrEqual(cases);
  });

  test('without an Approved Model no evals run, and the proposal says why', async () => {
    await setAnalysisAfter(0);
    await script(3);
    await analyze();
    const view = await proposal(1);
    expect(view.before).toBeNull();
    expect(view.after).toBeNull();
    expect(view.comparison).toBeNull();
    expect(view.evalsNote).toContain('No Approved Model');
  });

  // ─── Decide ───────────────────────────────────────────────────────────────

  test('Approve makes it active, and the next call uses it', async () => {
    await approvedModel();
    await setAnalysisAfter(0);
    await script(20);
    await analyze();
    await test_.proposals.drain();

    const approved = await asPim()<PromptVersionView>('POST', `${CHOICES}/versions/1/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'APPROVED', active: true });
    expect((await prompts.choose('generateChoices')).number).toBe(1);
    ai.calls.length = 0;
    await raise('After approval');
    expect(ai.calls[0]?.prompt?.number).toBe(1);

    // The approval is an outcome of the AI's own proposal.
    await test_.proposals.drain();
    const outcome = await db.receiptOutcome.findFirstOrThrow({
      where: { proposalKind: 'PROMPT_VERSION' },
      include: { receipt: { select: { task: true } } },
    });
    expect(outcome).toMatchObject({ kind: 'APPROVE', actorId: pim.id, redraftsBeforeApproval: 0 });
    expect(outcome.receipt.task).toBe('proposePromptVersion');

    // Rollback works as in 0071.
    const back = await asPim()('POST', `${CHOICES}/rollback`, { version: 0 });
    expect(back.status).toBe(201);
    expect((await prompts.choose('generateChoices')).number).toBe(0);
  });

  test('Request changes produces Redraft 2 and reruns its evals', async () => {
    await approvedModel();
    await setAnalysisAfter(0);
    await script(20);
    await analyze();
    const first = await proposal(1);
    const v1 = first.version;

    ai.calls.length = 0;
    const res = await asPim()<RequestChangesResult>(
      'POST',
      `/prompt-versions/${v1.id}/request-changes`,
      { feedback: 'Also say: never more than three Choices.' },
    );
    expect(res.status).toBe(201);
    expect(res.body.redraft).toMatchObject({
      number: 2,
      status: 'READY',
      feedback: 'Also say: never more than three Choices.',
      requestedBy: { id: pim.id, name: pim.name },
    });
    expect(res.body.redrafts.redrafts.map((r) => r.number)).toEqual([1, 2]);
    expect(res.body.diff.lines.some((l) => l.kind === 'ADDED' && l.text.includes('three'))).toBe(
      true,
    );

    // The AI was given the proposal, the patterns and the version active now.
    const call = ai.calls.find((c) => c.method === 'redraftPromptVersion');
    expect(call?.input).toMatchObject({
      current: 1,
      template: v1.template,
      active: await readSkillSource('generate-choices'),
      patterns: [expect.objectContaining({ count: 20, examples: [SHORTER, SHORTER, SHORTER] })],
    });

    // The version holds Redraft 2; fresh evals ran on it, named for its new template.
    const second = await proposal(1);
    expect(second.version.template).toContain('Changed as asked: Also say: never more than three');
    expect(second.version.rationale).toContain('never more than three');
    expect(second.version.version).toBe(await promptVersionOf(1, second.version.template));
    expect(second.after?.id).not.toBe(first.after?.id);
    expect(second.before?.id).not.toBe(first.before?.id);
    expect(second.after).toMatchObject({ status: 'DONE', version: second.version.version });
    expect(second.comparison).not.toBeNull();

    const listed = await asPim()<ProposalRedraftsView>('GET', `/prompt-versions/${v1.id}/redrafts`);
    expect(listed.body).toMatchObject({
      kind: 'PROMPT_VERSION',
      current: 2,
      canRequestChanges: true,
    });

    // Approve applies Redraft 2.
    await asPim()('POST', `${CHOICES}/versions/1/approve`);
    const chosen = await prompts.choose('generateChoices');
    expect(chosen.template).toBe(second.version.template);
    await test_.proposals.drain();
    const outcomes = await db.receiptOutcome.findMany({
      where: { proposalKind: 'PROMPT_VERSION' },
      orderBy: { createdAt: 'asc' },
    });
    expect(outcomes.map((o) => [o.kind, o.redraft])).toEqual([
      ['REQUEST_CHANGES', 1],
      ['APPROVE', 2],
    ]);
    // Once approved, it can't be redrafted.
    const late = await asPim()('POST', `/prompt-versions/${v1.id}/request-changes`, {
      feedback: 'More',
    });
    expect(late.status).toBe(409);
  });

  test('a Redraft the AI fails to write changes nothing', async () => {
    await setAnalysisAfter(0);
    await script(3);
    await analyze();
    const before = (await proposal(1)).version;
    ai.redraftScript.push(new Error('provider down'));
    const res = await asPim()('POST', `/prompt-versions/${before.id}/request-changes`, {
      feedback: 'Shorter still.',
    });
    expect(res.status).toBe(502);
    expect((await proposal(1)).version.template).toBe(before.template);
  });

  test('Decline takes a reason and stores it', async () => {
    await setAnalysisAfter(0);
    await script(3);
    await analyze();
    const without = await asPim()('POST', `${CHOICES}/versions/1/decline`, {});
    expect(without.status).toBe(422);
    const declined = await asPim()<PromptVersionView>('POST', `${CHOICES}/versions/1/decline`, {
      reason: 'Short is fine, but not at the cost of the impact lines.',
    });
    expect(declined.status).toBe(201);
    expect(declined.body).toMatchObject({
      status: 'DECLINED',
      declineReason: 'Short is fine, but not at the cost of the impact lines.',
      declinedBy: { id: pim.id, name: pim.name },
    });
    expect((await prompts.choose('generateChoices')).number).toBe(0);
    await test_.proposals.drain();
    const outcome = await db.receiptOutcome.findFirstOrThrow({
      where: { proposalKind: 'PROMPT_VERSION' },
    });
    expect(outcome).toMatchObject({
      kind: 'DECLINE',
      reason: 'Short is fine, but not at the cost of the impact lines.',
    });
    const id = declined.body.id;
    expect(
      (await asPim()('POST', `/prompt-versions/${id}/request-changes`, { feedback: 'x' })).status,
    ).toBe(409);
  });

  test('a version written by hand has no proposal view and is never redrafted', async () => {
    const template = `${(await readSkillSource('generate-choices')).trimEnd()}\n\nBe brief.\n`;
    const written = await asPim()<PromptVersionView>('POST', `${CHOICES}/versions`, { template });
    expect(written.body).toMatchObject({ analysisId: null, rationale: null });
    expect((await asPim()('GET', `${CHOICES}/versions/1/proposal`)).status).toBe(404);
    const res = await asPim()('POST', `/prompt-versions/${written.body.id}/request-changes`, {
      feedback: 'Shorter',
    });
    expect(res.status).toBe(422);
    // Declining it still needs no reason (0071).
    expect((await asPim()('POST', `${CHOICES}/versions/1/decline`, {})).status).toBe(201);
  });

  // ─── Never publishes by itself ────────────────────────────────────────────

  test('without approval every task keeps the active version, even when the proposal scores higher', async () => {
    await approvedModel();
    await setAnalysisAfter(0);
    await script(20);
    await analyze();
    const view = await proposal(1);
    // The proposal scores higher than the version active now.
    await db.promptEvalRun.update({ where: { id: view.after?.id }, data: { score: 1 } });
    await db.promptEvalRun.update({ where: { id: view.before?.id }, data: { score: 0.2 } });
    await db.promptEvalCase.updateMany({ where: { runId: view.after?.id }, data: { score: 1 } });
    const higher = await proposal(1);
    expect(higher.after?.score).toBeGreaterThan(higher.before?.score ?? 1);

    for (const task of Object.keys(AI_TASKS) as AiTask[]) {
      expect((await prompts.choose(task)).number, task).toBe(0);
    }
    ai.calls.length = 0;
    await raise('Still on the default');
    expect(ai.calls[0]?.prompt).toMatchObject({ number: 0, template: null });
    const list = await asPim()<PromptsView>('GET', BASE);
    expect(list.body.prompts.find((p) => p.name === 'generate-choices')).toMatchObject({
      active: { number: 0 },
      proposed: 1,
    });
  });

  // ─── Analysing on its own ─────────────────────────────────────────────────

  test('enough new feedback starts an analysis on its own, once', async () => {
    expect((await asPim()<PromptsView>('GET', BASE)).body.analysisAfter).toBe(20);
    const request = await script(19);
    expect(await db.promptAnalysis.count()).toBe(0);
    const list = await asPim()<PromptsView>('GET', BASE);
    expect(list.body.prompts.find((p) => p.name === 'generate-choices')?.newFeedback).toBe(19);

    // The 20th outcome: the AI reads the feedback, and proposes a version.
    test_.receipts.outcome({
      kind: 'REQUEST_CHANGES',
      proposal: { kind: 'CHOICES', id: request.id },
      actorId: beam.id,
      redraft: 1,
      reason: SHORTER,
    });
    await test_.proposals.drain();
    const analyses = await db.promptAnalysis.findMany();
    expect(analyses).toHaveLength(1);
    expect(analyses[0]).toMatchObject({
      promptName: 'generate-choices',
      trigger: 'FEEDBACK',
      status: 'DONE',
      outcomes: 20,
      requestedById: null,
    });
    expect(await db.promptVersion.count({ where: { status: 'PROPOSED' } })).toBe(1);

    // While its proposal waits, more feedback doesn't start another.
    await script(25);
    expect(await db.promptAnalysis.count()).toBe(1);
  });

  // ─── Who ──────────────────────────────────────────────────────────────────

  test('only an Admin can analyse, see, approve, decline or request changes (403 otherwise)', async () => {
    await setAnalysisAfter(0);
    await script(3);
    await analyze();
    const v1 = (await proposal(1)).version;
    const calls: [method: 'GET' | 'POST' | 'PUT', url: string, body?: object][] = [
      ['POST', `${CHOICES}/analyses`],
      ['GET', `${CHOICES}/versions/1/proposal`],
      ['POST', `${CHOICES}/versions/1/approve`],
      ['POST', `${CHOICES}/versions/1/decline`, { reason: 'No' }],
      ['POST', `/prompt-versions/${v1.id}/request-changes`, { feedback: 'Shorter' }],
      ['GET', `/prompt-versions/${v1.id}/redrafts`],
      ['GET', `/prompt-versions/${v1.id}/redrafts/diff?from=1&to=1`],
      ['GET', '/settings/ai/prompt-analysis'],
      ['PUT', '/settings/ai/prompt-analysis', { analysisAfter: 5 }],
    ];
    ai.calls.length = 0;
    for (const [method, url, body] of calls) {
      const res = await asBeam()(method, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(ai.calls).toHaveLength(0);
    expect(await db.redraft.count()).toBe(0);
    expect(await db.promptAnalysis.count()).toBe(1);
    expect((await db.promptVersion.findFirstOrThrow()).status).toBe('PROPOSED');
  });
});
