import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Prisma, PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiBudgetView,
  AiProviderView,
  AiSettingsView,
  AiUsageView,
  ApprovedModelSettingsView,
  DecideResult,
  DecisionRequestView,
  NotificationList,
  SpecVersionView,
} from '@vorasaan/shared';
import { FAKE_USAGE } from '../ai/fake-ai.port.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const USAGE = '/settings/ai/usage';
const MARCH = `${USAGE}?from=2026-03-01&to=2026-03-31`;

/** A Receipt as the tests script it: only what the dashboard reads, the rest defaulted. */
function receipt(
  fields: Partial<Prisma.ReceiptUncheckedCreateInput> & { at: string },
): Prisma.ReceiptUncheckedCreateInput {
  const { at, ...rest } = fields;
  return {
    task: 'generateChoices',
    taskKind: 'CHOICES',
    promptName: 'generate-choices',
    promptVersion: 'default@000000000000',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 100,
    success: true,
    createdAt: new Date(at),
    ...rest,
  };
}

describe('AI usage dashboard and budget (ticket 0075)', () => {
  let test_: TestApp;
  let app: NestFastifyApplication;
  let db: PrismaClient;
  const asPim = () => as(app, pim.id);
  const asBeam = () => as(app, beam.id);

  /** An Approved Model on a new provider (the first one becomes the default). */
  async function approvedModel(
    displayName: string,
    prices: { inputPerMillion: number; outputPerMillion: number } | null,
  ): Promise<ApprovedModelSettingsView> {
    const provider = await asPim()<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: `Provider ${displayName}`,
      apiKey: 'sk-ant-test-1234',
    });
    expect(provider.status).toBe(201);
    const model = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.body.id,
      modelId: `model-${displayName.toLowerCase()}`,
      displayName,
      prices,
    });
    expect(model.status).toBe(201);
    return model.body;
  }

  async function usage(url = USAGE): Promise<AiUsageView> {
    await test_.receipts.drain();
    const res = await asPim()<AiUsageView>('GET', url);
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Beam raises a Blocker: one AI call (its Choices). */
  async function raise(title: string): Promise<DecisionRequestView> {
    const res = await asBeam()<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title,
      description: 'Only polling is available.',
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function notificationTypes(userId: string): Promise<string[]> {
    await test_.receipts.drain();
    const res = await as(app, userId)<NotificationList>('GET', '/notifications');
    expect(res.status).toBe(200);
    return res.body.notifications.map((n) => n.type).sort();
  }

  beforeAll(async () => {
    test_ = await createTestApp();
    ({ app } = test_);
    db = createTestPrisma();
  });

  afterAll(async () => {
    await test_.receipts.drain();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await test_.receipts.drain();
    await truncateAll(db);
    await seed(db);
    test_.clock.reset();
  });

  test('usage totals by task, Project and model match the Receipts written', async () => {
    const priced = await approvedModel('Fast', { inputPerMillion: 3, outputPerMillion: 15 });
    const unpriced = await approvedModel('Local', null);
    const other = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Cards' },
    });
    const evalRun = crypto.randomUUID();
    await db.receipt.createMany({
      data: [
        // Choices on the priced model in the seeded Project: four successes and one failure.
        ...[100, 400, 200, 300].map((latencyMs, i) =>
          receipt({
            at: `2026-03-0${i + 2}T10:00:00Z`,
            approvedModelId: priced.id,
            modelName: 'model-fast',
            projectId: SEED.projectId,
            latencyMs,
            cacheReadTokens: 250,
          }),
        ),
        receipt({
          at: '2026-03-02T11:00:00Z',
          approvedModelId: priced.id,
          projectId: SEED.projectId,
          latencyMs: 9000,
          success: false,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
        }),
        // Chat in another Project, on the model without a price.
        receipt({
          at: '2026-03-03T09:00:00Z',
          task: 'chat',
          taskKind: 'CHAT',
          promptName: 'chat',
          approvedModelId: unpriced.id,
          modelName: 'model-local',
          projectId: other.id,
          inputTokens: 4000,
          outputTokens: 500,
          latencyMs: 1500,
        }),
        // A server-set model for the whole Organization (Prompt proposals).
        receipt({
          at: '2026-03-04T09:00:00Z',
          task: 'analyzeFeedback',
          taskKind: 'PROMPT_PROPOSALS',
          promptName: 'analyze-feedback',
          modelSource: 'ENV',
          modelName: 'anthropic/claude-env',
          inputTokens: 2000,
          outputTokens: 200,
          latencyMs: 800,
        }),
        // An Eval Run of the Choices: counted apart from the Choices.
        receipt({
          at: '2026-03-05T09:00:00Z',
          approvedModelId: priced.id,
          evalRunId: evalRun,
          inputTokens: 500,
          outputTokens: 50,
          latencyMs: 50,
        }),
        // Outside the range: left out.
        receipt({ at: '2026-02-28T23:59:59Z', approvedModelId: priced.id }),
        receipt({ at: '2026-04-01T00:00:00Z', approvedModelId: priced.id }),
      ],
    });

    const view = await usage(MARCH);
    const cost = (input: number, output: number) => (input * 3 + output * 15) / 1e6;

    expect(view).toMatchObject({ from: '2026-03-01', to: '2026-03-31', timeZone: 'UTC' });
    expect(view.totals).toMatchObject({
      calls: 8,
      failedCalls: 1,
      inputTokens: 4 * 1000 + 4000 + 2000 + 500,
      outputTokens: 4 * 100 + 500 + 200 + 50,
      cacheReadTokens: 1000,
      unpricedCalls: 2,
    });
    expect(view.totals.costUsd).toBeCloseTo(cost(4500, 450), 9);

    const tasks = Object.fromEntries(view.byTask.map((t) => [t.task, t]));
    expect(view.byTask.map((t) => t.task)).toEqual([
      'CHOICES',
      'CHAT',
      'PROMPT_PROPOSALS',
      'EVAL_RUN',
    ]);
    expect(tasks.CHOICES).toMatchObject({
      calls: 5,
      failedCalls: 1,
      inputTokens: 4000,
      outputTokens: 400,
      cacheReadTokens: 1000,
      cacheHitRatio: 0.25,
      unpricedCalls: 0,
      // Nearest rank over the four successes (100, 200, 300, 400); the failure is left out.
      latencyP50Ms: 200,
      latencyP95Ms: 400,
    });
    expect(tasks.CHOICES?.costUsd).toBeCloseTo(cost(4000, 400), 9);
    expect(tasks.CHAT).toMatchObject({
      calls: 1,
      inputTokens: 4000,
      costUsd: null,
      unpricedCalls: 1,
    });
    expect(tasks.PROMPT_PROPOSALS).toMatchObject({ calls: 1, costUsd: null, latencyP50Ms: 800 });
    expect(tasks.EVAL_RUN).toMatchObject({ calls: 1, inputTokens: 500, outputTokens: 50 });
    expect(tasks.EVAL_RUN?.costUsd).toBeCloseTo(cost(500, 50), 9);

    const projects = Object.fromEntries(view.byProject.map((p) => [p.projectName ?? 'none', p]));
    expect(projects['Mobile Banking']).toMatchObject({
      projectId: SEED.projectId,
      calls: 5,
      inputTokens: 4000,
    });
    expect(projects.Cards).toMatchObject({ projectId: other.id, calls: 1, costUsd: null });
    expect(projects.none).toMatchObject({ projectId: null, calls: 2, inputTokens: 2500 });

    const models = Object.fromEntries(view.byModel.map((m) => [m.name, m]));
    expect(models.Fast).toMatchObject({
      approvedModelId: priced.id,
      priced: true,
      calls: 6,
      inputTokens: 4500,
      outputTokens: 450,
    });
    expect(models.Fast?.costUsd).toBeCloseTo(cost(4500, 450), 9);
    expect(models.Local).toMatchObject({ approvedModelId: unpriced.id, priced: false, calls: 1 });
    expect(models['anthropic/claude-env']).toMatchObject({ approvedModelId: null, calls: 1 });
    // The priced model comes first: it costs something.
    expect(view.byModel[0]?.name).toBe('Fast');

    // Every breakdown adds up to the totals.
    for (const rows of [view.byTask, view.byProject, view.byModel]) {
      expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(view.totals.calls);
      expect(rows.reduce((n, r) => n + r.inputTokens, 0)).toBe(view.totals.inputTokens);
    }

    // One day per day of the range, zeros included.
    expect(view.daily).toHaveLength(31);
    expect(view.daily[1]).toMatchObject({ date: '2026-03-02', calls: 2, inputTokens: 1000 });
    expect(view.daily[2]).toMatchObject({ date: '2026-03-03', calls: 2, inputTokens: 5000 });
    expect(view.daily[9]).toMatchObject({ date: '2026-03-10', calls: 0, costUsd: null });
    expect(view.anyPrices).toBe(true);
  });

  test('days and the range follow the Organization time zone', async () => {
    await db.responseWindowSettings.create({
      data: {
        organizationId: SEED.organizationId,
        timeZone: 'Asia/Bangkok',
        workingDays: [1, 2, 3, 4, 5],
        workStartMinute: 540,
        workEndMinute: 1080,
        blockerWindow: 4,
        blockerWindowUnit: 'WORKING_HOURS',
        questionWindow: 2,
        questionWindowUnit: 'WORKING_DAYS',
      },
    });
    await db.receipt.createMany({
      data: [
        // 2026-03-01 06:00 in Bangkok (UTC+7): inside the range, on March 1st.
        receipt({ at: '2026-02-28T23:00:00Z' }),
        // 2026-04-01 01:00 in Bangkok: outside.
        receipt({ at: '2026-03-31T18:00:00Z' }),
      ],
    });
    const view = await usage(MARCH);
    expect(view.timeZone).toBe('Asia/Bangkok');
    expect(view.totals.calls).toBe(1);
    expect(view.daily[0]).toMatchObject({ date: '2026-03-01', calls: 1 });
  });

  test('the cache hit ratio and Redrafts before approval match scripted Receipts', async () => {
    const drafted = await db.receipt.create({
      data: receipt({ at: '2026-03-10T10:00:00Z', inputTokens: 2000, cacheReadTokens: 1500 }),
    });
    await db.receipt.create({
      data: receipt({
        at: '2026-03-10T11:00:00Z',
        task: 'draftSpecProposal',
        taskKind: 'SPEC_PROPOSAL',
        promptName: 'draft-spec-proposal',
        inputTokens: 3000,
        cacheReadTokens: 0,
      }),
    });
    const outcome = (
      proposalKind: 'CHOICES' | 'SPEC_PROPOSAL',
      redraftsBeforeApproval: number,
      at = '2026-03-12T10:00:00Z',
    ): Prisma.ReceiptOutcomeUncheckedCreateInput => ({
      receiptId: drafted.id,
      kind: 'APPROVE',
      proposalKind,
      proposalId: crypto.randomUUID(),
      redraft: redraftsBeforeApproval + 1,
      redraftsBeforeApproval,
      createdAt: new Date(at),
    });
    await db.receiptOutcome.createMany({
      data: [
        outcome('CHOICES', 0),
        outcome('CHOICES', 0),
        outcome('CHOICES', 3),
        outcome('SPEC_PROPOSAL', 1),
        // Not an approval, and an approval outside the range: neither counts.
        { ...outcome('SPEC_PROPOSAL', 0), kind: 'DECLINE', redraftsBeforeApproval: null },
        outcome('SPEC_PROPOSAL', 5, '2026-04-02T10:00:00Z'),
      ],
    });

    const view = await usage(MARCH);
    expect(view.totals.cacheHitRatio).toBeCloseTo(1500 / 5000, 9);
    expect(view.byTask.find((t) => t.task === 'CHOICES')?.cacheHitRatio).toBe(0.75);
    expect(view.byTask.find((t) => t.task === 'SPEC_PROPOSAL')?.cacheHitRatio).toBe(0);
    expect(view.redraftsBeforeApproval).toEqual([
      { proposalKind: 'CHOICES', approvals: 3, firstDraftApprovals: 2, averageRedrafts: 1 },
      { proposalKind: 'SPEC_PROPOSAL', approvals: 1, firstDraftApprovals: 0, averageRedrafts: 1 },
    ]);
  });

  test('cost per decision includes the Choices, their Redrafts and the Spec Proposal of one Decision Request', async () => {
    await approvedModel('Fast', { inputPerMillion: 2, outputPerMillion: 10 });
    // Beam raises a Blocker (the Choices), asks for a Redraft of them, and sends it.
    const draft = await raise('Provider has no webhook');
    const redraft = await asBeam()(
      'POST',
      `/decision-requests/${draft.id}/choices/request-changes`,
      {
        feedback: 'Add a Choice for polling every minute.',
      },
    );
    expect(redraft.status).toBe(201);
    const { body: open } = await asBeam()<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    const choice = open.choices[0];
    if (!choice) throw new Error('expected a Choice');
    // Pim decides: the Spec Proposal; she asks for one Redraft of it and approves that.
    const decided = await asPim()<DecideResult>('POST', `/decision-requests/${open.id}/decision`, {
      choiceId: choice.id,
    });
    expect(decided.status).toBe(201);
    const proposal = decided.body.proposal;
    if (!proposal) throw new Error('expected a Spec Proposal');
    const changed = await asPim()('POST', `/spec-proposals/${proposal.id}/request-changes`, {
      feedback: 'Mention the retry limit',
    });
    expect(changed.status).toBe(201);
    const approved = await asPim()<SpecVersionView>(
      'POST',
      `/spec-proposals/${proposal.id}/approve`,
      { redraft: 2 },
    );
    expect(approved.status).toBe(201);

    // Not part of it: a request still open, and an Eval Run pointing at the same request.
    await raise('Another question');
    await db.receipt.create({
      data: receipt({
        at: new Date().toISOString(),
        proposalKind: 'CHOICES',
        proposalId: draft.id,
        redraft: 1,
        evalRunId: crypto.randomUUID(),
      }),
    });

    const view = await usage();
    const perCall = FAKE_USAGE.inputTokens ?? 0;
    const perCallOut = FAKE_USAGE.outputTokens ?? 0;
    // Choices, their Redraft, the Spec Proposal and its Redraft: four calls.
    expect(view.costPerDecision).toMatchObject({
      decisions: 1,
      calls: 4,
      averageTokens: 4 * (perCall + perCallOut),
      unpricedCalls: 0,
    });
    expect(view.costPerDecision.averageCostUsd).toBeCloseTo(
      (4 * (perCall * 2 + perCallOut * 10)) / 1e6,
      9,
    );
    // The Receipts written by the app carry the seeded Project.
    expect(view.byProject.map((p) => p.projectId)).toEqual([SEED.projectId, null]);
    expect(view.redraftsBeforeApproval).toEqual([
      { proposalKind: 'CHOICES', approvals: 1, firstDraftApprovals: 0, averageRedrafts: 1 },
      { proposalKind: 'SPEC_PROPOSAL', approvals: 1, firstDraftApprovals: 0, averageRedrafts: 1 },
    ]);
  });

  test('crossing 80% and 100% of the budget sends one Notification each to the Admins', async () => {
    // Each Choices call: 1,200 tokens in and 300 out at $100 a million each = $0.15.
    await approvedModel('Fast', { inputPerMillion: 100, outputPerMillion: 100 });
    const set = await asPim()<AiBudgetView>('PUT', `${USAGE}/budget`, { monthlyUsd: 0.5 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ monthlyUsd: 0.5, spentUsd: 0, share: 0 });

    await raise('One'); // $0.15: 30%
    await raise('Two'); // $0.30: 60%
    expect(await notificationTypes(pim.id)).toEqual([]);
    await raise('Three'); // $0.45: 90%
    expect(await notificationTypes(pim.id)).toEqual(['AI_BUDGET_WARNING']);
    await raise('Four'); // $0.60: 120%
    expect(await notificationTypes(pim.id)).toEqual(['AI_BUDGET_REACHED', 'AI_BUDGET_WARNING']);
    // More calls, some at once: still one of each. Nothing is blocked.
    await Promise.all([raise('Five'), raise('Six'), raise('Seven')]);
    expect(await notificationTypes(pim.id)).toEqual(['AI_BUDGET_REACHED', 'AI_BUDGET_WARNING']);
    // Only Admins hear of it.
    expect(await notificationTypes(beam.id)).toEqual([]);

    const view = await usage();
    expect(view.budget.monthlyUsd).toBe(0.5);
    expect(view.budget.spentUsd).toBeCloseTo(7 * 0.15, 9);
    expect(view.budget.share).toBeCloseTo((7 * 0.15) / 0.5, 9);
    expect(view.budget.month).toBe(new Date().toISOString().slice(0, 7));

    // A new budget is checked afresh: already past it, so one more REACHED (and no WARNING).
    await asPim()('PUT', `${USAGE}/budget`, { monthlyUsd: 1 });
    expect(await notificationTypes(pim.id)).toEqual([
      'AI_BUDGET_REACHED',
      'AI_BUDGET_REACHED',
      'AI_BUDGET_WARNING',
    ]);
    // No budget: no more Notifications.
    await asPim()('PUT', `${USAGE}/budget`, { monthlyUsd: null });
    await raise('Eight');
    expect((await notificationTypes(pim.id)).length).toBe(3);
  });

  test('without prices there is no cost, only tokens, and no budget Notification', async () => {
    await approvedModel('Local', null);
    await asPim()('PUT', `${USAGE}/budget`, { monthlyUsd: 0.01 });
    await raise('One');
    const view = await usage();
    expect(view.anyPrices).toBe(false);
    expect(view.totals).toMatchObject({
      calls: 1,
      inputTokens: FAKE_USAGE.inputTokens,
      costUsd: null,
      unpricedCalls: 1,
    });
    expect(view.budget.spentUsd).toBe(0);
    expect(await notificationTypes(pim.id)).toEqual([]);
  });

  test('prices are set on an Approved Model, both or neither', async () => {
    const model = await approvedModel('Fast', null);
    const priced = await asPim()<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${model.id}`,
      {
        prices: { inputPerMillion: 3, outputPerMillion: 15 },
      },
    );
    expect(priced.status).toBe(200);
    expect(priced.body.prices).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    const { body: settings } = await asPim()<AiSettingsView>('GET', '/settings/ai');
    expect(settings.models[0]?.prices).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });

    const half = await asPim()('PATCH', `/settings/ai/models/${model.id}`, {
      prices: { inputPerMillion: 3 },
    });
    expect(half.status).toBe(400);
    const negative = await asPim()('PATCH', `/settings/ai/models/${model.id}`, {
      prices: { inputPerMillion: -1, outputPerMillion: 1 },
    });
    expect(negative.status).toBe(400);

    const cleared = await asPim()<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${model.id}`,
      {
        prices: null,
      },
    );
    expect(cleared.body.prices).toBeNull();
  });

  test('a range must be valid', async () => {
    expect((await asPim()('GET', `${USAGE}?from=2026-03-10&to=2026-03-01`)).status).toBe(400);
    expect((await asPim()('GET', `${USAGE}?from=2024-01-01&to=2026-03-01`)).status).toBe(400);
    expect((await asPim()('GET', `${USAGE}?from=yesterday`)).status).toBe(400);
    expect((await asPim()('PUT', `${USAGE}/budget`, { monthlyUsd: 0 })).status).toBe(400);
    const today = await usage();
    expect(today.daily).toHaveLength(30);
    expect(today.to).toBe(new Date().toISOString().slice(0, 10));
  });

  test('only an Admin can read usage or set the budget (403 otherwise)', async () => {
    expect((await asBeam()('GET', USAGE)).status).toBe(403);
    expect((await asBeam()('GET', MARCH)).status).toBe(403);
    expect((await asBeam()('PUT', `${USAGE}/budget`, { monthlyUsd: 5 })).status).toBe(403);
    const org = await db.organization.findUniqueOrThrow({ where: { id: SEED.organizationId } });
    expect(org.aiMonthlyBudget).toBeNull();
  });
});
