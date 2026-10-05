import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiProviderView,
  AiSettingsView,
  ApprovedModelSettingsView,
  ModelSuggestionsView,
  PromptEvalRunView,
} from '@vorasaan/shared';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { promptsOfTask } from './model-suggestions.ts';

// Cheaper models for simple tasks (ticket 0076): a model is suggested for a task only when
// it is priced lower and its Eval Runs score at least as well on every prompt of the task.
// The Admin decides: nothing is switched by itself.

const { pim, beam } = SEED.users;
const URL_ = '/settings/ai/model-suggestions';

describe('Cheaper models for simple tasks (ticket 0076)', () => {
  let test_: TestApp;
  let app: NestFastifyApplication;
  let db: PrismaClient;
  const asPim = () => as(app, pim.id);

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

  /** An Eval Run of the active (default) version of `prompt` on `model`, run to the end. */
  async function evalRun(prompt: string, model: ApprovedModelSettingsView): Promise<string> {
    const res = await asPim()<PromptEvalRunView>('POST', `/settings/ai/prompts/${prompt}/evals`, {
      version: 0,
      approvedModelId: model.id,
      sources: ['CHECKED_IN'],
    });
    expect(res.status).toBe(201);
    await test_.evals.drain();
    return res.body.id;
  }

  async function suggestions(): Promise<ModelSuggestionsView> {
    await test_.receipts.drain();
    const res = await asPim()<ModelSuggestionsView>('GET', URL_);
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    test_ = await createTestApp();
    ({ app } = test_);
    db = createTestPrisma();
  });

  afterAll(async () => {
    await test_.evals.drain();
    await test_.receipts.drain();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await test_.evals.drain();
    await test_.receipts.drain();
    await truncateAll(db);
    await seed(db);
  });

  test('Summaries on a cheaper model whose scores hold: suggested, and nothing is switched', async () => {
    const best = await approvedModel('Best', { inputPerMillion: 15, outputPerMillion: 75 });
    const fast = await approvedModel('Fast', { inputPerMillion: 1, outputPerMillion: 5 });
    expect(promptsOfTask('SUMMARIES')).toEqual(['summarize-attachment', 'summarize-conversation']);
    for (const prompt of promptsOfTask('SUMMARIES')) {
      await evalRun(prompt, best);
      await evalRun(prompt, fast);
    }

    const view = await suggestions();
    const summaries = view.suggestions.find((s) => s.task === 'SUMMARIES');
    expect(summaries).toMatchObject({
      current: { approvedModelId: best.id, name: 'Best' },
      suggested: { approvedModelId: fast.id, name: 'Fast' },
    });
    expect(summaries?.prompts.map((p) => p.prompt)).toEqual(promptsOfTask('SUMMARIES'));
    for (const p of summaries?.prompts ?? []) {
      expect(p.suggested.score).toBeGreaterThanOrEqual(p.current.score);
      expect(p.version).toStartWith('default@');
    }
    // The Eval Runs' own calls are not the task's: no calls priced yet.
    expect(summaries?.calls).toBe(0);
    // Every other task has a cheaper model too, but no scores: evals to run.
    const choices = view.unchecked.find((u) => u.task === 'CHOICES');
    expect(choices?.suggested.name).toBe('Fast');
    expect(choices?.prompts).toContain('generate-choices');
    expect(view.suggestions.map((s) => s.task)).toEqual(['SUMMARIES']);

    // Only a suggestion: Summaries still run on the default until an Admin sets them.
    const settings = await asPim()<AiSettingsView>('GET', '/settings/ai');
    expect(settings.body.tasks.find((t) => t.task === 'SUMMARIES')?.approvedModelId).toBeNull();
    const set = await asPim()<AiSettingsView>('PUT', '/settings/ai/tasks', {
      tasks: { SUMMARIES: fast.id },
    });
    expect(set.status).toBe(200);
    // Now on Fast, the cheapest: nothing cheaper to suggest for Summaries.
    expect((await suggestions()).suggestions).toEqual([]);
  });

  test('a lower score on one prompt of the task, or a higher price, suggests nothing', async () => {
    const best = await approvedModel('Best', { inputPerMillion: 15, outputPerMillion: 75 });
    const fast = await approvedModel('Fast', { inputPerMillion: 1, outputPerMillion: 5 });
    const dear = await approvedModel('Dear', { inputPerMillion: 30, outputPerMillion: 150 });
    const runs: Record<string, string> = {};
    for (const prompt of promptsOfTask('SUMMARIES')) {
      await evalRun(prompt, best);
      runs[prompt] = await evalRun(prompt, fast);
      await evalRun(prompt, dear);
    }
    expect((await suggestions()).suggestions.map((s) => s.suggested.name)).toEqual(['Fast']);

    // Fast's latest run on the conversation summary scores a little lower: not suggested.
    await db.promptEvalRun.update({
      where: { id: runs['summarize-conversation'] },
      data: { score: { decrement: 0.01 } },
    });
    const view = await suggestions();
    expect(view.suggestions).toEqual([]);
    expect(view.unchecked.find((u) => u.task === 'SUMMARIES')).toBeUndefined();
  });

  test('the task’s own calls are priced on both models', async () => {
    const best = await approvedModel('Best', { inputPerMillion: 10, outputPerMillion: 50 });
    const fast = await approvedModel('Fast', { inputPerMillion: 1, outputPerMillion: 5 });
    for (const prompt of promptsOfTask('SUMMARIES')) {
      await evalRun(prompt, best);
      await evalRun(prompt, fast);
    }
    await db.receipt.createMany({
      data: [1, 2].map(() => ({
        task: 'summarizeAttachment',
        taskKind: 'SUMMARIES',
        promptName: 'summarize-attachment',
        promptVersion: 'default@000000000000',
        approvedModelId: best.id,
        inputTokens: 500_000,
        outputTokens: 100_000,
        latencyMs: 100,
        success: true,
      })),
    });
    const summaries = (await suggestions()).suggestions.find((s) => s.task === 'SUMMARIES');
    expect(summaries?.calls).toBe(2);
    // 1M in and 200k out: $10 + $10 on Best, $1 + $1 on Fast.
    expect(summaries?.currentCostUsd).toBeCloseTo(20, 6);
    expect(summaries?.suggestedCostUsd).toBeCloseTo(2, 6);
  });

  test('without prices nothing is cheaper, and only an Admin sees suggestions', async () => {
    const best = await approvedModel('Best', null);
    const fast = await approvedModel('Fast', null);
    for (const prompt of promptsOfTask('SUMMARIES')) {
      await evalRun(prompt, best);
      await evalRun(prompt, fast);
    }
    expect(await suggestions()).toEqual({ suggestions: [], unchecked: [] });
    expect((await as(app, beam.id)('GET', URL_)).status).toBe(403);
  });
});
