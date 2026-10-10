import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  ActivePromptView,
  AiProviderView,
  ApprovedModelSettingsView,
  DecideResult,
  DecisionRequestView,
  PromptDetailView,
  PromptDiff,
  PromptEvalComparison,
  PromptEvalRunSummary,
  PromptEvalRunView,
  PromptsView,
  PromptVersionView,
} from '@vorasaan/shared';
import { promptVersionOf, readSkillSource, SKILLS, skillVersion } from '@vorasaan/skills';
import { AI_TASKS, type AiTask } from '../ai/ai.config.ts';
import { FAKE_USAGE, type FakeAiPort } from '../ai/fake-ai.port.ts';
import { generateChoicesPrompt, TASK_SKILLS } from '../ai/prompts.ts';
import { casesForPrompt, EVAL_CASES } from '../evals/eval-sets.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { PromptVersionsService } from './prompt-versions.service.ts';

const { pim, beam } = SEED.users;
const DAY = 24 * 60 * 60 * 1000;
const BASE = '/settings/ai/prompts';

describe('Prompt Versions and evals (ticket 0071)', () => {
  let test_: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let prompts: PromptVersionsService;
  const asPim = () => as(app, pim.id);
  const asBeam = () => as(app, beam.id);

  /** The default Choices prompt with one line changed: a valid Prompt Version. */
  async function choicesTemplate(line: string): Promise<string> {
    return `${(await readSkillSource('generate-choices')).trimEnd()}\n\n${line}\n`;
  }

  /** Pim writes a Prompt Version of the Choices prompt; returns it, proposed. */
  async function propose(line: string, name = 'generate-choices'): Promise<PromptVersionView> {
    const template =
      name === 'generate-choices'
        ? await choicesTemplate(line)
        : `${(await readSkillSource(name as 'chat')).trimEnd()}\n\n${line}\n`;
    const res = await asPim()<PromptVersionView>('POST', `${BASE}/${name}/versions`, {
      template,
      note: line,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function approve(number: number, name = 'generate-choices') {
    const res = await asPim()<PromptVersionView>(
      'POST',
      `${BASE}/${name}/versions/${number}/approve`,
    );
    expect(res.status).toBe(201);
    return res.body;
  }

  /** Beam raises a Blocker: the Choices are generated (one AI call). */
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

  /** Beam raises and sends a Blocker to Pim, who decides Choice B: an approved Choices proposal. */
  async function decided(title: string): Promise<DecideResult> {
    const draft = await raise(title);
    const { body: open } = await asBeam()<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    const choice = open.choices[1];
    if (!choice) throw new Error('expected a Choice B');
    const res = await asPim()<DecideResult>('POST', `/decision-requests/${open.id}/decision`, {
      choiceId: choice.id,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  /** An Approved Model to run evals on (the fake answers, whatever the model). */
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

  async function startEval(body: object, name = 'generate-choices') {
    return asPim()<PromptEvalRunSummary>('POST', `${BASE}/${name}/evals`, body);
  }

  async function finished(runId: string, name = 'generate-choices'): Promise<PromptEvalRunView> {
    await test_.evals.drain();
    const res = await asPim()<PromptEvalRunView>('GET', `${BASE}/${name}/evals/${runId}`);
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
    test_.clock.reset();
  });

  // ─── Defaults, versions and their Receipts ────────────────────────────────

  test('with no Prompt Version, every task uses the packages/skills default', async () => {
    for (const task of Object.keys(AI_TASKS) as AiTask[]) {
      const name = TASK_SKILLS[task];
      expect(await prompts.choose(task)).toEqual({
        name,
        version: await skillVersion(name),
        number: 0,
        template: null,
      });
    }
    const list = await asPim()<PromptsView>('GET', BASE);
    expect(list.status).toBe(200);
    expect(list.body.prompts.map((p) => p.name)).toEqual([...SKILLS]);
    expect(list.body.prompts.every((p) => p.active.number === 0 && p.versions === 0)).toBe(true);

    await raise();
    expect(ai.calls[0]?.prompt).toMatchObject({
      name: 'generate-choices',
      number: 0,
      template: null,
    });
    await test_.receipts.drain();
    const receipt = await db.receipt.findFirstOrThrow();
    expect(receipt.promptVersion).toBe(await skillVersion('generate-choices'));
  });

  test('once one is active, the task uses it and its Receipt names it; other prompts keep the default', async () => {
    const proposed = await propose('Keep each Choice under 40 words.');
    expect(proposed).toMatchObject({ number: 1, status: 'PROPOSED', active: false });
    expect(proposed.proposedBy).toEqual({ id: pim.id, name: pim.name });

    // A proposal changes nothing until it is approved.
    await raise('Before approval');
    expect(ai.calls.at(-1)?.prompt?.number).toBe(0);

    test_.clock.set(new Date('2026-10-01T09:00:00Z'));
    const approved = await approve(1);
    expect(approved).toMatchObject({
      status: 'APPROVED',
      active: true,
      approvedBy: { id: pim.id, name: pim.name },
      approvedAt: '2026-10-01T09:00:00.000Z',
    });
    const version = await promptVersionOf(1, proposed.template);
    expect(approved.version).toBe(version);

    ai.calls.length = 0;
    await raise('After approval');
    expect(ai.calls[0]?.prompt).toEqual({
      name: 'generate-choices',
      version,
      number: 1,
      template: proposed.template,
    });
    await test_.receipts.drain();
    // Raised before and after the approval (the clock was set back meanwhile).
    const receipts = await db.receipt.findMany();
    expect(receipts.map((r) => r.promptVersion).sort()).toEqual(
      [await skillVersion('generate-choices'), version].sort(),
    );
    expect((await prompts.choose('chat')).number).toBe(0);
    expect((await prompts.choose('redraftChoices')).number).toBe(0);

    const detail = await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`);
    expect(detail.body.active).toMatchObject({ number: 1, version, by: { id: pim.id } });
    expect(detail.body.history).toEqual([
      { number: 1, kind: 'APPROVE', by: { id: pim.id, name: pim.name }, at: expect.any(String) },
    ]);
    expect(detail.body.default.template).toBe(await readSkillSource('generate-choices'));
  });

  test("an active version's template is what the prompt renders", async () => {
    const template = await choicesTemplate('ALWAYS-SHORT-MARKER');
    const request = {
      kind: 'BLOCKER' as const,
      raiserRole: 'BACKEND' as const,
      title: 'Webhook',
      description: 'None.',
    };
    const custom = await generateChoicesPrompt('# Spec', request, [], undefined, { template });
    const builtIn = await generateChoicesPrompt('# Spec', request, []);
    expect(custom.text).toContain('ALWAYS-SHORT-MARKER');
    expect(custom.text).toContain('Webhook');
    expect(builtIn.text).not.toContain('ALWAYS-SHORT-MARKER');
  });

  test('versions are numbered, immutable and must render', async () => {
    await propose('One.');
    await propose('Two.');
    const detail = await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`);
    expect(detail.body.versions.map((v) => v.number)).toEqual([2, 1]);

    const base = await readSkillSource('generate-choices');
    const unknown = await asPim()('POST', `${BASE}/generate-choices/versions`, {
      template: `${base}\n{{password}}`,
    });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('{{password}}');
    const missing = await asPim()('POST', `${BASE}/generate-choices/versions`, {
      template: base.replaceAll('{{spec}}', ''),
    });
    expect(missing.status).toBe(422);
    expect(JSON.stringify(missing.body)).toContain('{{spec}}');
    const partial = await asPim()('POST', `${BASE}/generate-choices/versions`, {
      template: `${base}\n{{>nope}}`,
    });
    expect(partial.status).toBe(422);
    expect((await asPim()('GET', `${BASE}/no-such-prompt`)).status).toBe(404);

    // Approved once; a second approval, or approving a declined one, conflicts.
    await approve(1);
    expect((await asPim()('POST', `${BASE}/generate-choices/versions/1/approve`)).status).toBe(409);
    const declined = await asPim()<PromptVersionView>(
      'POST',
      `${BASE}/generate-choices/versions/2/decline`,
      { reason: 'Too terse' },
    );
    expect(declined.body).toMatchObject({ status: 'DECLINED', declineReason: 'Too terse' });
    expect((await asPim()('POST', `${BASE}/generate-choices/versions/2/approve`)).status).toBe(409);
    expect(
      (await asPim()('POST', `${BASE}/generate-choices/rollback`, { version: 2 })).status,
    ).toBe(409);
  });

  test('rollback makes the earlier version active, is recorded, and the next call uses it', async () => {
    await propose('First.');
    await approve(1);
    await propose('Second.');
    await approve(2);
    expect((await prompts.choose('generateChoices')).number).toBe(2);

    const back = await asPim()<ActivePromptView>('POST', `${BASE}/generate-choices/rollback`, {
      version: 1,
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ number: 1, by: { id: pim.id } });
    ai.calls.length = 0;
    await raise('After rollback');
    expect(ai.calls[0]?.prompt?.number).toBe(1);

    // Back to the built-in default.
    await asPim()('POST', `${BASE}/generate-choices/rollback`, { version: 0 });
    ai.calls.length = 0;
    await raise('On the default');
    expect(ai.calls[0]?.prompt).toMatchObject({ number: 0, template: null });
    await test_.receipts.drain();
    const last = await db.receipt.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(last.promptVersion).toBe(await skillVersion('generate-choices'));

    const detail = await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`);
    expect(detail.body.history.map((h) => [h.kind, h.number])).toEqual([
      ['ROLLBACK', 0],
      ['ROLLBACK', 1],
      ['APPROVE', 2],
      ['APPROVE', 1],
    ]);
    expect(detail.body.versions.find((v) => v.active)).toBeUndefined();
    // Already active.
    expect(
      (await asPim()('POST', `${BASE}/generate-choices/rollback`, { version: 0 })).status,
    ).toBe(409);
  });

  test('the diff between two Prompt Versions, or one and the default, is returned', async () => {
    await propose('Keep each Choice under 40 words.');
    await propose('Keep each Choice under 30 words.');
    const res = await asPim()<PromptDiff>('GET', `${BASE}/generate-choices/diff?from=1&to=2`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: 1, to: 2, added: 1, removed: 1 });
    expect(res.body.lines.filter((l) => l.kind !== 'UNCHANGED')).toEqual([
      expect.objectContaining({ kind: 'REMOVED', text: 'Keep each Choice under 40 words.' }),
      expect.objectContaining({ kind: 'ADDED', text: 'Keep each Choice under 30 words.' }),
    ]);
    const fromDefault = await asPim()<PromptDiff>(
      'GET',
      `${BASE}/generate-choices/diff?from=0&to=1`,
    );
    expect(fromDefault.body).toMatchObject({ from: 0, to: 1, removed: 0 });
    expect(fromDefault.body.added).toBeGreaterThan(0);
    expect((await asPim()('GET', `${BASE}/generate-choices/diff?from=0&to=9`)).status).toBe(404);
  });

  // ─── Evals ────────────────────────────────────────────────────────────────

  test('an eval run with the fake scores every case and stores the scores; two runs compare', async () => {
    const model = await approvedModel();
    const proposed = await propose('Keep each Choice under 40 words.');
    const cases = casesForPrompt('generate-choices');
    expect(cases.length).toBeGreaterThan(3);

    const started = await startEval({
      version: 1,
      approvedModelId: model.id,
      sources: ['CHECKED_IN'],
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      status: 'RUNNING',
      total: cases.length,
      number: 1,
      model: { approvedModelId: model.id, displayName: 'Eval', name: 'model-eval' },
    });
    const run = await finished(started.body.id);
    expect(run.status).toBe('DONE');
    expect(run.done).toBe(cases.length);
    expect(run.cases.map((c) => c.key)).toEqual(cases.map((c) => c.key));
    for (const c of run.cases) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.checks[0]).toMatchObject({ name: 'A valid answer', passed: true });
      expect(c.output).toMatchObject({ suggestedRole: 'PO' });
    }
    // The fake answers in English: the English cases pass, the Thai ones lose their language.
    const english = run.cases.find((c) => c.name === 'Provider has no webhook for payment status');
    expect(english?.score).toBe(1);
    const thai = run.cases.find((c) => c.name === 'ปุ่ม Retry ควรอยู่ตรงไหน');
    expect(thai?.score).toBeLessThan(1);
    expect(thai?.checks.find((c) => c.name === 'Written in Thai')?.passed).toBe(false);
    expect(run.score).toBeCloseTo(run.cases.reduce((s, c) => s + c.score, 0) / cases.length, 6);
    expect(run.setScores).toHaveLength(1);
    expect(run.setScores[0]).toMatchObject({ set: 'choices', cases: cases.length });
    expect(run.setScores[0]?.score).toBeCloseTo(run.score ?? -1, 6);

    // Every case went through the AI port with the version and the model picked, and left a
    // Receipt marked with the run: the run's tokens are summed from them.
    const evalCalls = ai.calls.filter((c) => c.method === 'generateChoices');
    expect(evalCalls).toHaveLength(cases.length);
    expect(evalCalls.every((c) => c.prompt?.template === proposed.template)).toBe(true);
    expect(evalCalls.every((c) => c.model?.approvedModelId === model.id)).toBe(true);
    expect(evalCalls.find((c) => c.language === 'th')).toBeDefined();
    const receipts = await db.receipt.findMany({ where: { evalRunId: run.id } });
    expect(receipts).toHaveLength(cases.length);
    expect(receipts.every((r) => r.promptVersion === proposed.version)).toBe(true);
    expect(run.usage).toEqual({
      inputTokens: (FAKE_USAGE.inputTokens ?? 0) * cases.length,
      outputTokens: (FAKE_USAGE.outputTokens ?? 0) * cases.length,
      cacheReadTokens: (FAKE_USAGE.cacheReadTokens ?? 0) * cases.length,
      cacheWriteTokens: (FAKE_USAGE.cacheWriteTokens ?? 0) * cases.length,
    });

    // The default, on the same cases; then the two side by side.
    const other = await startEval({
      version: 0,
      approvedModelId: model.id,
      sources: ['CHECKED_IN'],
    });
    const baseline = await finished(other.body.id);
    expect(baseline).toMatchObject({ status: 'DONE', number: 0 });
    const compared = await asPim()<PromptEvalComparison>(
      'GET',
      `${BASE}/generate-choices/evals/compare?a=${baseline.id}&b=${run.id}`,
    );
    expect(compared.status).toBe(200);
    expect(compared.body.a.id).toBe(baseline.id);
    expect(compared.body.b.id).toBe(run.id);
    expect(compared.body.sets).toHaveLength(1);
    expect(compared.body.sets[0]?.set).toBe('choices');
    expect(compared.body.sets[0]?.a).toBeCloseTo(baseline.score ?? -1, 6);
    expect(compared.body.sets[0]?.b).toBeCloseTo(run.score ?? -1, 6);
    expect(compared.body.cases).toHaveLength(cases.length);
    for (const c of compared.body.cases) {
      expect(c.a?.score).toBeNumber();
      expect(c.b?.score).toBeNumber();
      expect(c.a?.output).toBeDefined();
    }

    const detail = await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`);
    expect(detail.body.runs.map((r) => r.id).sort()).toEqual([run.id, baseline.id].sort());
    expect(detail.body.evalSets).toEqual([{ set: 'choices', cases: cases.length }]);
  });

  test('a failing case scores 0 with its error, and the run still ends', async () => {
    const model = await approvedModel();
    ai.failures.push(new Error('Provider overloaded'));
    const started = await startEval({
      version: 0,
      approvedModelId: model.id,
      sources: ['CHECKED_IN'],
    });
    const run = await finished(started.body.id);
    expect(run.status).toBe('DONE');
    expect(run.cases[0]).toMatchObject({ score: 0, output: null });
    expect(run.cases[0]?.error).toContain('Provider overloaded');
    expect(run.cases.slice(1).every((c) => c.error === null)).toBe(true);
  });

  test('every checked-in case has a unique key, and Thai cases in every set', () => {
    const keys = EVAL_CASES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sets = new Set(EVAL_CASES.map((c) => c.set));
    for (const set of sets) {
      expect(EVAL_CASES.some((c) => c.set === set && c.lang?.language === 'th')).toBe(true);
    }
  });

  test('a run needs an Approved Model, a version that exists, and cases', async () => {
    const model = await approvedModel();
    const otherOrgModel = '00000000-0000-4000-8000-000000000000';
    expect(
      (await startEval({ version: 0, approvedModelId: otherOrgModel, sources: ['CHECKED_IN'] }))
        .status,
    ).toBe(422);
    expect(
      (await startEval({ version: 7, approvedModelId: model.id, sources: ['CHECKED_IN'] })).status,
    ).toBe(404);
    // No Receipt of the Choices prompt was approved yet: nothing to replay.
    expect(
      (await startEval({ version: 0, approvedModelId: model.id, sources: ['REPLAY'] })).status,
    ).toBe(422);
  });

  test('replay picks only approved Receipts, and leaves out ones whose inputs are gone', async () => {
    const model = await approvedModel();
    const kept = await decided('Webhook or polling?');
    await raise('Raised, never decided');
    const gone = await decided('Retry button placement');
    // The second decided request's Feature material is deleted: its inputs are gone.
    await db.decisionRequest.delete({ where: { id: gone.request.id } });
    await test_.receipts.drain();

    const detail = await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`);
    expect(detail.body.replay).toEqual({ supported: true, receipts: 1 });

    const started = await startEval({ version: 0, approvedModelId: model.id, sources: ['REPLAY'] });
    expect(started.status).toBe(201);
    const run = await finished(started.body.id);
    expect(run.cases).toHaveLength(1);
    const keptReceipt = await db.receipt.findFirstOrThrow({
      where: { proposalId: kept.request.id, evalRunId: null },
    });
    expect(run.cases[0]).toMatchObject({
      set: 'replay',
      key: `replay/${keptReceipt.id}`,
      receiptId: keptReceipt.id,
      // The fake answers the same request with the same Choices that were approved.
      score: 1,
    });
    const replayed = ai.calls.at(-1);
    expect(replayed?.method).toBe('generateChoices');
    expect(replayed?.input).toMatchObject({ request: { title: 'Webhook or polling?' } });

    // An eval run's own Receipts are never replayed.
    await test_.receipts.drain();
    expect(
      (await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`)).body.replay,
    ).toEqual({ supported: true, receipts: 1 });

    // Past retention, the approved Receipt is deleted, and with it the replay.
    test_.clock.set(new Date(Date.now() + 91 * DAY));
    await test_.receipts.purge();
    expect(
      (await asPim()<PromptDetailView>('GET', `${BASE}/generate-choices`)).body.replay,
    ).toEqual({ supported: true, receipts: 0 });
  });

  test('a Spec Proposal approved is replayed against the approved Spec', async () => {
    const model = await approvedModel();
    const { proposal } = await decided('Webhook or polling?');
    expect((await asPim()('POST', `/spec-proposals/${proposal.id}/approve`, {})).status).toBe(201);
    await test_.receipts.drain();
    const started = await startEval(
      { version: 0, approvedModelId: model.id, sources: ['REPLAY'] },
      'draft-spec-proposal',
    );
    expect(started.status).toBe(201);
    const run = await finished(started.body.id, 'draft-spec-proposal');
    expect(run.cases).toHaveLength(1);
    expect(run.cases[0]).toMatchObject({ set: 'replay', score: 1 });
    expect(run.cases[0]?.checks[0]).toMatchObject({
      name: 'Close to the approved Spec',
      passed: true,
    });
  });

  // ─── Admins only ──────────────────────────────────────────────────────────

  test('only an Admin can see, write, approve, roll back or run evals (403 otherwise)', async () => {
    const model = await approvedModel();
    await propose('Shorter.');
    const member = asBeam();
    for (const [method, url, body] of [
      ['GET', BASE, undefined],
      ['GET', `${BASE}/generate-choices`, undefined],
      ['POST', `${BASE}/generate-choices/versions`, { template: 'x' }],
      ['POST', `${BASE}/generate-choices/versions/1/approve`, undefined],
      ['POST', `${BASE}/generate-choices/versions/1/decline`, {}],
      ['POST', `${BASE}/generate-choices/rollback`, { version: 0 }],
      ['GET', `${BASE}/generate-choices/diff?from=0&to=1`, undefined],
      [
        'POST',
        `${BASE}/generate-choices/evals`,
        { version: 1, approvedModelId: model.id, sources: ['CHECKED_IN'] },
      ],
    ] as const) {
      const res = await member(method, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect((await prompts.choose('generateChoices')).number).toBe(0);
    expect(await db.promptEvalRun.count()).toBe(0);
  });
});
