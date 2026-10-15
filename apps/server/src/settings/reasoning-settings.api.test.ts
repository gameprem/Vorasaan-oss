import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiModelsView,
  AiProviderView,
  AiSettingsView,
  ApprovedModelSettingsView,
  ConversationTurnView,
  ConversationView,
} from '@vorasaan/shared';
import { AI_PORT, type AiPort, type RequestForAi } from '../ai/ai.port.ts';
import { FAKE_REASONING_TOKENS, type FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// Ticket 0081: the Reasoning Level per task (an Admin's setting, the env override, the
// defaults), "Think deeper" on one chat message, and the level and the reasoning tokens on
// the Receipt and the reply. Real Postgres; the fake AI port records each call's level.

const { pim, beam } = SEED.users;

const request: RequestForAi = {
  kind: 'BLOCKER',
  title: 'No webhook',
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};

describe('Reasoning Level (0081)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;
  let claude: ApprovedModelSettingsView;
  let local: ApprovedModelSettingsView;

  beforeAll(async () => {
    testApp = await createTestApp();
    ({ app, ai } = testApp);
    db = createTestPrisma();
    asAdmin = as(app, pim.id);
    asMember = as(app, beam.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    const anthropic = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: 'sk-ant-reasoning-0081',
    });
    const router = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'OPENAI_COMPATIBLE',
      name: 'Local router',
      baseUrl: 'http://localhost:20128/v1',
      apiKey: 'local-token-0081',
    });
    claude = (
      await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
        providerId: anthropic.body.id,
        modelId: 'claude-opus-5-5',
        displayName: 'Best',
      })
    ).body;
    local = (
      await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
        providerId: router.body.id,
        modelId: 'qwen-3-coder',
        displayName: 'Local',
      })
    ).body;
  });

  afterEach(() => {
    for (const name of [
      'VORASAAN_REASONING',
      'VORASAAN_REASONING_GENERATE_CHOICES',
      'VORASAAN_REASONING_CHAT',
      'VORASAAN_MODEL_GENERATE_CHOICES',
    ]) {
      delete process.env[name];
    }
  });

  const port = () => app.get<AiPort>(AI_PORT);
  const choices = () => port().generateChoices({ specMarkdown: '# Spec', request, context: [] });
  const levels = () => ai.calls.map((c) => c.reasoning);

  test('task defaults: low for structured tasks and Redrafts, medium for chat, Spec from Attachments, Design Docs', async () => {
    await choices();
    await port().draftSpecFromAttachments({
      feature: { title: 'F', description: '' },
      specMarkdown: '',
      context: [],
    });
    for await (const _ of port().chat({
      scope: { kind: 'PROJECT', project: { name: 'P' } },
      context: [],
      foundation: { brief: null, guidelines: [] },
      summary: '',
      recentMessages: [{ role: 'USER', content: 'hi' }],
      tools: [],
    })) {
      // drained
    }
    expect(levels()).toEqual([
      { level: 'LOW', source: 'DEFAULT' },
      { level: 'MEDIUM', source: 'DEFAULT' },
      { level: 'MEDIUM', source: 'DEFAULT' },
    ]);
  });

  test('the Admin sets a task’s level; it applies on the next call, and null goes back to the default', async () => {
    const res = await asAdmin<AiSettingsView>('PUT', '/settings/ai/reasoning', {
      tasks: { CHOICES: 'HIGH', CHAT: 'LOW' },
    });
    expect(res.status).toBe(200);
    const view = (task: string) => res.body.tasks.find((t) => t.task === task);
    expect(view('CHOICES')).toMatchObject({ reasoningLevel: 'HIGH', reasoningEnvOverrides: [] });
    expect(view('CHAT')?.reasoningLevel).toBe('LOW');
    expect(view('SUMMARIES')?.reasoningLevel).toBeNull();
    await choices();
    expect(levels().at(-1)).toEqual({ level: 'HIGH', source: 'SETTINGS' });

    await asAdmin('PUT', '/settings/ai/reasoning', { tasks: { CHOICES: 'MEDIUM' } });
    await choices();
    expect(levels().at(-1)).toEqual({ level: 'MEDIUM', source: 'SETTINGS' });

    const back = await asAdmin<AiSettingsView>('PUT', '/settings/ai/reasoning', {
      tasks: { CHOICES: null },
    });
    expect(back.body.tasks.find((t) => t.task === 'CHOICES')?.reasoningLevel).toBeNull();
    // Leaving a task out keeps it.
    expect(back.body.tasks.find((t) => t.task === 'CHAT')?.reasoningLevel).toBe('LOW');
    await choices();
    expect(levels().at(-1)).toEqual({ level: 'LOW', source: 'DEFAULT' });
  });

  test('admin only, and a level must be one of LOW, MEDIUM, HIGH', async () => {
    expect(
      (await asMember('PUT', '/settings/ai/reasoning', { tasks: { CHOICES: 'LOW' } })).status,
    ).toBe(403);
    expect(
      (await asAdmin('PUT', '/settings/ai/reasoning', { tasks: { CHOICES: 'MAX' } })).status,
    ).toBe(400);
    expect(
      (await asAdmin('PUT', '/settings/ai/reasoning', { tasks: { NOPE: 'LOW' } })).status,
    ).toBe(400);
  });

  test('the env override wins, for an env model and in Settings', async () => {
    await asAdmin('PUT', '/settings/ai/reasoning', { tasks: { CHOICES: 'HIGH' } });
    process.env.VORASAAN_MODEL_GENERATE_CHOICES = 'anthropic/claude-opus-5-5';
    process.env.VORASAAN_REASONING_GENERATE_CHOICES = 'medium';
    await choices();
    expect(ai.calls.at(-1)?.model?.source).toBe('ENV');
    expect(levels().at(-1)).toEqual({ level: 'MEDIUM', source: 'ENV' });
    const view = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(view.body.tasks.find((t) => t.task === 'CHOICES')?.reasoningEnvOverrides).toEqual([
      'VORASAAN_REASONING_GENERATE_CHOICES',
    ]);
  });

  test('each Approved Model says whether its level can be set', async () => {
    const view = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(view.body.models.map((m) => [m.displayName, m.reasoning])).toEqual([
      ['Best', { supported: true, reason: null }],
      ['Local', { supported: false, reason: 'Not supported by this provider' }],
    ]);
    const models = await asMember<AiModelsView>('GET', '/ai/models');
    expect(models.body.models.map((m) => m.reasoning.supported)).toEqual([true, false]);
    expect(models.body.chatDefaultReasoning).toEqual({ supported: true, reason: null });
    // Turned off on the server: no model can think deeper in chat.
    process.env.VORASAAN_REASONING_CHAT = 'off';
    const off = await asMember<AiModelsView>('GET', '/ai/models');
    expect(off.body.models[0]?.reasoning).toEqual({
      supported: false,
      reason: 'Turned off on the server (VORASAAN_REASONING_CHAT)',
    });
  });

  test('the Receipt records the level sent, and none for a model with no control', async () => {
    await choices();
    await port().generateChoices(
      { specMarkdown: '# Spec', request, context: [] },
      { approvedModelId: local.id },
    );
    await testApp.receipts.drain();
    const rows = await db.receipt.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.modelName, r.reasoningLevel, r.reasoningTokens])).toEqual([
      ['claude-opus-5-5', 'LOW', 100],
      ['qwen-3-coder', null, 100],
    ]);
  });

  describe('Think deeper', () => {
    const asPim = () => as(app, pim.id);
    const feature = { kind: 'FEATURE', featureId: SEED.featureId };

    test('a message sent with it runs at HIGH and shows its reasoning tokens; the next one goes back', async () => {
      await asAdmin('PUT', '/settings/ai/reasoning', { tasks: { CHAT: 'LOW' } });
      const started = await asPim()<ConversationView>('POST', '/conversations', {
        scope: feature,
        content: 'Think hard about retries',
        reasoningLevel: 'HIGH',
      });
      expect(started.status).toBe(201);
      const [message, reply] = started.body.messages;
      expect(message).toMatchObject({
        role: 'USER',
        reasoningLevel: 'HIGH',
        reasoningTokens: null,
      });
      expect(reply).toMatchObject({
        role: 'ASSISTANT',
        reasoningLevel: 'HIGH',
        reasoningTokens: FAKE_REASONING_TOKENS.HIGH,
      });

      const next = await asPim()<ConversationTurnView>(
        'POST',
        `/conversations/${started.body.id}/messages`,
        { content: 'And timeouts?' },
      );
      expect(next.status).toBe(201);
      expect(next.body.message.reasoningLevel).toBeNull();
      expect(next.body.reply).toMatchObject({
        reasoningLevel: null,
        reasoningTokens: FAKE_REASONING_TOKENS.LOW,
      });

      const sent = await asPim()<ConversationTurnView>(
        'POST',
        `/conversations/${started.body.id}/messages`,
        { content: 'Once more, deeply', reasoningLevel: 'HIGH' },
      );
      expect(sent.body.reply.reasoningLevel).toBe('HIGH');

      const chats = ai.calls.filter((c) => c.method === 'chat').map((c) => c.reasoning);
      expect(chats).toEqual([
        { level: 'HIGH', source: 'MESSAGE' },
        { level: 'LOW', source: 'SETTINGS' },
        { level: 'HIGH', source: 'MESSAGE' },
      ]);
      await testApp.receipts.drain();
      const receipts = await db.receipt.findMany({
        where: { task: 'chat' },
        orderBy: { createdAt: 'asc' },
      });
      expect(receipts.map((r) => [r.reasoningLevel, r.reasoningTokens])).toEqual([
        ['HIGH', FAKE_REASONING_TOKENS.HIGH],
        ['LOW', FAKE_REASONING_TOKENS.LOW],
        ['HIGH', FAKE_REASONING_TOKENS.HIGH],
      ]);
    });

    test('a retry of a failed reply keeps the message’s level', async () => {
      ai.scriptChat({ error: new Error('provider down') });
      const started = await asPim()<{ conversationId: string }>('POST', '/conversations', {
        scope: feature,
        content: 'Deep one',
        reasoningLevel: 'HIGH',
      });
      expect(started.status).toBe(502);
      const retried = await asPim()<ConversationTurnView>(
        'POST',
        `/conversations/${started.body.conversationId}/retry`,
      );
      expect(retried.status).toBe(201);
      expect(retried.body.reply.reasoningLevel).toBe('HIGH');
      expect(ai.calls.filter((c) => c.method === 'chat').map((c) => c.reasoning?.level)).toEqual([
        'HIGH',
        'HIGH',
      ]);
    });

    test('a level other than LOW, MEDIUM or HIGH is a 400', async () => {
      const res = await asPim()('POST', '/conversations', {
        scope: feature,
        content: 'x',
        reasoningLevel: 'MAX',
      });
      expect(res.status).toBe(400);
    });
  });

  test('the Organization default still applies to its Approved Model', () => {
    expect(claude.reasoning.supported).toBe(true);
    expect(local.reasoning.supported).toBe(false);
  });
});
