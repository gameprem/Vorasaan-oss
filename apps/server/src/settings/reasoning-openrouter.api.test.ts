import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiModelsView,
  AiProviderView,
  AiSettingsView,
  ApprovedModelSettingsView,
  ConversationView,
} from '@vorasaan/shared';
import { AI_PORT, type AiPort, type RequestForAi } from '../ai/ai.port.ts';
import { MastraAiPort } from '../ai/mastra-ai.port.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { type FakeOpenRouter, startFakeOpenRouter } from '../test/fake-openrouter.ts';
import { as } from '../test/http.ts';

// Ticket 0081's follow-ups, through the whole app on MastraAiPort, against a local stand-in
// for OpenRouter's API (no real key, no network), with real Postgres:
// - a Receipt (and a reply) records the level really sent: none when the provider refused
//   the reasoning parameter and the call went again without it;
// - an OpenRouter model whose listing lacks `reasoning` has no reasoning control.

const { pim, beam } = SEED.users;

// Unique to this file: Mastra keeps model instances per key.
const KEY = 'sk-or-v1-reasoning-follow-ups-0081';

const CHOICES = {
  suggestedRole: 'PO',
  choices: ['A', 'B'].map((label) => ({
    label,
    title: `Option ${label}`,
    description: 'd',
    impactScope: 's',
    impactTime: 't',
    impactRisk: 'r',
  })),
};

const request: RequestForAi = {
  kind: 'BLOCKER',
  title: 'No webhook',
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};

const LISTED = [
  {
    id: 'example/thinker',
    name: 'Example: Thinker',
    context_length: 131_072,
    supported_parameters: ['tools', 'response_format', 'reasoning', 'include_reasoning'],
  },
  {
    id: 'example/no-think',
    name: 'Example: No think',
    context_length: 65_536,
    supported_parameters: ['tools', 'response_format', 'temperature'],
  },
  // OpenRouter's list says nothing of this one's parameters.
  { id: 'example/unsaid', name: 'Example: Unsaid', context_length: 32_768 },
];

const REASONING_TOKENS = 48;
const NOT_SUPPORTED = { supported: false, reason: 'This model has no reasoning control' };

describe('Reasoning Level follow-ups on OpenRouter (0081)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let fake: FakeOpenRouter;
  let previousUrl: string | undefined;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;
  let providerId: string;

  beforeAll(async () => {
    fake = startFakeOpenRouter(KEY);
    previousUrl = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = fake.url;
    testApp = await createTestApp({ engine: () => new MastraAiPort() });
    app = testApp.app;
    db = createTestPrisma();
    asAdmin = as(app, pim.id);
    asMember = as(app, beam.id);
  });

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previousUrl;
    fake.stop();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    fake.models = LISTED;
    fake.modelsStatus = null;
    fake.structured = CHOICES;
    fake.refuse = () => null;
    fake.usage = {
      prompt_tokens: 900,
      completion_tokens: 60,
      total_tokens: 960,
      completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
    };
    const provider = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'OPENROUTER',
      name: 'OpenRouter',
      apiKey: KEY,
    });
    expect(provider.status).toBe(201);
    providerId = provider.body.id;
    fake.requests.length = 0;
  });

  const addModel = async (modelId: string, displayName: string) => {
    const res = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId,
      modelId,
      displayName,
    });
    expect(res.status).toBe(201);
    return res.body;
  };
  const port = () => app.get<AiPort>(AI_PORT);
  const choicesOn = (approvedModelId: string) =>
    port().generateChoices({ specMarkdown: '# Spec', request, context: [] }, { approvedModelId });
  /** The `reasoning` of each chat completion sent, null when none. */
  const sentReasoning = () =>
    fake.requests
      .filter((r) => r.path.endsWith('/chat/completions'))
      .map((r) => r.body?.reasoning ?? null);
  const receipts = async () => {
    await testApp.receipts.drain();
    return db.receipt.findMany({ orderBy: { createdAt: 'asc' } });
  };

  /** Runs with Logger's warnings caught, and Mastra's own error lines muted. */
  async function caught<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const warnings: string[] = [];
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { result: await run(), warnings };
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }

  describe('the Receipt records the level really sent', () => {
    beforeEach(() => {
      // A model that refuses the reasoning parameter with a 400.
      fake.refuse = (body) =>
        body.reasoning ? 'Reasoning is not supported for this model.' : null;
    });

    test('a task refused once records no level, and the tokens of the call that ran', async () => {
      const thinker = await addModel('example/thinker', 'Thinker');
      fake.requests.length = 0;
      const { result, warnings } = await caught(() => choicesOn(thinker.id));
      expect(result).toEqual(CHOICES as never);
      // Sent with the parameter, refused, then once more without it: logged.
      expect(sentReasoning()).toEqual([{ effort: 'low' }, null]);
      expect(warnings.filter((w) => w.includes('refused its reasoning parameter'))).toHaveLength(1);
      const [receipt] = await receipts();
      expect(receipt).toMatchObject({
        task: 'generateChoices',
        success: true,
        reasoningLevel: null,
        reasoningTokens: REASONING_TOKENS,
      });
    });

    test('a chat refused once: the Receipt and the reply record no level; the message keeps it', async () => {
      const thinker = await addModel('example/thinker', 'Thinker');
      fake.requests.length = 0;
      const { result: started, warnings } = await caught(() =>
        as(app, pim.id)<ConversationView>('POST', '/conversations', {
          scope: { kind: 'FEATURE', featureId: SEED.featureId },
          content: 'Think hard about retries',
          approvedModelId: thinker.id,
          reasoningLevel: 'HIGH',
        }),
      );
      expect(started.status).toBe(201);
      expect(sentReasoning()).toEqual([{ effort: 'high' }, null]);
      expect(warnings.filter((w) => w.includes('refused its reasoning parameter'))).toHaveLength(1);
      const [message, reply] = started.body.messages;
      // What the person asked for stays on their message (a retry keeps it)...
      expect(message).toMatchObject({ role: 'USER', reasoningLevel: 'HIGH' });
      // ...but the reply wasn't thought at HIGH: no "Thought deeper".
      expect(reply).toMatchObject({
        role: 'ASSISTANT',
        reasoningLevel: null,
        reasoningTokens: REASONING_TOKENS,
      });
      const rows = (await receipts()).filter((r) => r.task === 'chat');
      expect(rows.map((r) => [r.reasoningLevel, r.reasoningTokens])).toEqual([
        [null, REASONING_TOKENS],
      ]);
    });

    test('a call that is not refused still records its level', async () => {
      const thinker = await addModel('example/thinker', 'Thinker');
      fake.refuse = () => null;
      await choicesOn(thinker.id);
      const [receipt] = await receipts();
      expect(receipt?.reasoningLevel).toBe('LOW');
    });
  });

  describe('an OpenRouter model whose listing lacks reasoning has no reasoning control', () => {
    test('the model is marked from the list when added; unknown keeps the effort', async () => {
      const thinker = await addModel('example/thinker', 'Thinker');
      const noThink = await addModel('example/no-think', 'No think');
      const unsaid = await addModel('example/unsaid', 'Unsaid');
      const unlisted = await addModel('example/unlisted', 'Unlisted');
      expect(thinker.reasoning).toEqual({ supported: true, reason: null });
      expect(noThink.reasoning).toEqual(NOT_SUPPORTED);
      expect(unsaid.reasoning).toEqual({ supported: true, reason: null });
      expect(unlisted.reasoning).toEqual({ supported: true, reason: null });
      // The window still comes from the same list.
      expect(noThink.contextWindow).toBe(65_536);
      const rows = await db.approvedModel.findMany({ orderBy: { position: 'asc' } });
      expect(rows.map((r) => [r.modelId, r.supportsReasoning])).toEqual([
        ['example/thinker', true],
        ['example/no-think', false],
        ['example/unsaid', null],
        ['example/unlisted', null],
      ]);

      // Settings says so, and so does the chat picker: "Think deeper" is disabled, with why.
      const settings = await asAdmin<AiSettingsView>('GET', '/settings/ai');
      expect(settings.body.models.find((m) => m.id === noThink.id)?.reasoning).toEqual(
        NOT_SUPPORTED,
      );
      const picker = await asMember<AiModelsView>('GET', '/ai/models');
      expect(picker.body.models.find((m) => m.id === noThink.id)?.reasoning).toEqual(NOT_SUPPORTED);
      expect(picker.body.models.find((m) => m.id === thinker.id)?.reasoning.supported).toBe(true);

      // No reasoning parameter is sent to it; the others get their effort.
      fake.requests.length = 0;
      for (const m of [noThink, thinker, unsaid]) await choicesOn(m.id);
      expect(sentReasoning()).toEqual([null, { effort: 'low' }, { effort: 'low' }]);
      const levels = (await receipts()).map((r) => r.reasoningLevel);
      expect(levels).toEqual([null, 'LOW', 'LOW']);
    });

    test('a chat on it sends no parameter, even for "Think deeper"', async () => {
      await addModel('example/thinker', 'Thinker');
      const noThink = await addModel('example/no-think', 'No think');
      fake.requests.length = 0;
      const started = await as(app, pim.id)<ConversationView>('POST', '/conversations', {
        scope: { kind: 'FEATURE', featureId: SEED.featureId },
        content: 'Think hard',
        approvedModelId: noThink.id,
        reasoningLevel: 'HIGH',
      });
      expect(started.status).toBe(201);
      expect(sentReasoning()).toEqual([null]);
      const rows = (await receipts()).filter((r) => r.task === 'chat');
      expect(rows.map((r) => r.reasoningLevel)).toEqual([null]);
    });

    test('changing the model id reads the list again; an unreadable list leaves it unknown', async () => {
      const model = await addModel('example/thinker', 'Thinker');
      const changed = await asAdmin<ApprovedModelSettingsView>(
        'PATCH',
        `/settings/ai/models/${model.id}`,
        { modelId: 'example/no-think' },
      );
      expect(changed.status).toBe(200);
      expect(changed.body.reasoning).toEqual(NOT_SUPPORTED);

      fake.modelsStatus = 503;
      const back = await asAdmin<ApprovedModelSettingsView>(
        'PATCH',
        `/settings/ai/models/${model.id}`,
        { modelId: 'example/thinker' },
      );
      expect(back.body.reasoning).toEqual({ supported: true, reason: null });
      const row = await db.approvedModel.findUniqueOrThrow({ where: { id: model.id } });
      expect(row.supportsReasoning).toBeNull();

      // Renaming alone keeps what the list said.
      fake.modelsStatus = null;
      await asAdmin('PATCH', `/settings/ai/models/${model.id}`, { modelId: 'example/no-think' });
      fake.modelsStatus = 503;
      const renamed = await asAdmin<ApprovedModelSettingsView>(
        'PATCH',
        `/settings/ai/models/${model.id}`,
        { displayName: 'Renamed' },
      );
      expect(renamed.body.reasoning).toEqual(NOT_SUPPORTED);
    });
  });
});
