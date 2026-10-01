import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiModelsView,
  AiProviderView,
  AiSettingsView,
  AiTestResult,
  ApprovedModelSettingsView,
  ConversationView,
} from '@vorasaan/shared';
import { DEFAULT_MODEL } from '../ai/ai.config.ts';
import { AI_PORT, type AiPort, type ModelChoice } from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

const ANTHROPIC_KEY = 'sk-ant-secret-9876';
const LOCAL_KEY = 'local-router-token-5555';
const LOCAL_URL = 'http://localhost:20128/v1';

describe('AI providers and Approved Models', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let connection: TestApp['connection'];
  let db: PrismaClient;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;

  beforeAll(async () => {
    ({ app, ai, connection } = await createTestApp());
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
    connection.tester = async () => {};
    connection.calls = 0;
    ai.calls.length = 0;
  });

  afterEach(() => {
    delete process.env.VORASAAN_MODEL_CHAT;
    delete process.env.VORASAAN_MODEL_GENERATE_CHOICES;
  });

  async function connectAnthropic() {
    const res = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function connectLocal() {
    const res = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'OPENAI_COMPATIBLE',
      name: 'Local router',
      baseUrl: LOCAL_URL,
      apiKey: LOCAL_KEY,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function approve(providerId: string, modelId: string, displayName: string, extra = {}) {
    const res = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId,
      modelId,
      displayName,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  /** Two providers, "Best" (Anthropic, the default) and "Local" (OpenAI-compatible). */
  async function twoProviders() {
    const anthropic = await connectAnthropic();
    const local = await connectLocal();
    const best = await approve(anthropic.id, 'claude-opus-5-5', 'Best');
    const fast = await approve(local.id, 'qwen-3-coder', 'Local', { note: 'No data leaves' });
    return { anthropic, local, best, fast };
  }

  const choose = (...args: Parameters<AiSettingsService['chooseModel']>) =>
    app.get(AiSettingsService).chooseModel(...args);

  test('a new install has nothing configured, and every task falls back to env', async () => {
    const res = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(res.body.providers).toEqual([]);
    expect(res.body.models).toEqual([]);
    expect(res.body.tasks.map((t) => t.task)).toEqual([
      'CHOICES',
      'SPEC_PROPOSAL',
      'SUMMARIES',
      'GRILLING',
      'FEATURE_SUGGESTIONS',
      'FIT_CHECK',
      'CHAT',
    ]);
    expect(res.body.tasks.every((t) => t.approvedModelId === null)).toBe(true);
    expect(await choose('chat')).toEqual({
      source: 'ENV',
      approvedModelId: null,
      integrationId: null,
      provider: null,
      name: process.env.VORASAAN_MODEL ?? DEFAULT_MODEL,
    });
  });

  test('a non-Admin gets 403 on every settings route', async () => {
    const { anthropic, best } = await twoProviders();
    const routes: [Parameters<typeof asMember>[0], string, unknown?][] = [
      ['GET', '/settings/ai'],
      ['GET', '/settings/ai/providers'],
      ['POST', '/settings/ai/providers', { kind: 'ANTHROPIC', name: 'x', apiKey: 'k' }],
      ['PATCH', `/settings/ai/providers/${anthropic.id}`, { name: 'x' }],
      ['DELETE', `/settings/ai/providers/${anthropic.id}`],
      ['GET', '/settings/ai/models'],
      ['POST', '/settings/ai/models', { providerId: anthropic.id, modelId: 'm', displayName: 'M' }],
      ['PATCH', `/settings/ai/models/${best.id}`, { displayName: 'x' }],
      ['DELETE', `/settings/ai/models/${best.id}`],
      ['POST', `/settings/ai/models/${best.id}/test`],
      ['PUT', '/settings/ai/tasks', { tasks: { CHAT: best.id } }],
    ];
    for (const [method, url, body] of routes) {
      expect({ method, url, status: (await asMember(method, url, body)).status }).toEqual({
        method,
        url,
        status: 403,
      });
    }
    expect(connection.calls).toBe(0);
  });

  test('GET /ai/models lists names and notes for every member, never a key or a base URL', async () => {
    const { best, fast } = await twoProviders();
    const res = await asMember<AiModelsView>('GET', '/ai/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        { id: best.id, displayName: 'Best', note: null, isDefault: true },
        { id: fast.id, displayName: 'Local', note: 'No data leaves', isDefault: false },
      ],
    });
    const raw = JSON.stringify(res.body);
    for (const secret of [ANTHROPIC_KEY, LOCAL_KEY, LOCAL_URL, '9876', '5555', 'localhost']) {
      expect(raw).not.toContain(secret);
    }
  });

  test('keys are encrypted at rest and only their last four characters are shown', async () => {
    await twoProviders();
    const stored = await db.orgIntegration.findMany();
    for (const row of stored) {
      expect(row.secretEncrypted).not.toContain(ANTHROPIC_KEY);
      expect(row.secretEncrypted).not.toContain(LOCAL_KEY);
    }
    const res = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(res.body.providers).toEqual([
      {
        id: expect.any(String),
        kind: 'ANTHROPIC',
        name: 'Anthropic',
        baseUrl: null,
        apiKeyHint: '…9876',
        modelCount: 1,
      },
      {
        id: expect.any(String),
        kind: 'OPENAI_COMPATIBLE',
        name: 'Local router',
        baseUrl: LOCAL_URL,
        apiKeyHint: '…5555',
        modelCount: 1,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  test('several providers of the same kind can be connected', async () => {
    await connectLocal();
    await connectLocal();
    expect(await db.orgIntegration.count({ where: { provider: 'OPENAI_COMPATIBLE' } })).toBe(2);
  });

  test('editing a provider without a key keeps the stored one; only a custom endpoint has a URL', async () => {
    const { anthropic, local, fast } = await twoProviders();
    const renamed = await asAdmin<AiProviderView>('PATCH', `/settings/ai/providers/${local.id}`, {
      name: 'Router',
      baseUrl: 'http://router.internal/v1',
    });
    expect(renamed.body).toMatchObject({ name: 'Router', apiKeyHint: '…5555' });
    expect((await choose('chat', fast.id)).provider).toEqual({
      provider: 'OPENAI_COMPATIBLE',
      model: 'qwen-3-coder',
      apiKey: LOCAL_KEY,
      baseUrl: 'http://router.internal/v1',
    });

    await asAdmin('PATCH', `/settings/ai/providers/${local.id}`, { apiKey: 'new-token-1111' });
    expect((await choose('chat', fast.id)).provider?.apiKey).toBe('new-token-1111');

    const refused = await asAdmin('PATCH', `/settings/ai/providers/${anthropic.id}`, {
      baseUrl: 'http://example.test/v1',
    });
    expect(refused.status).toBe(422);
    // A custom endpoint needs its URL.
    const noUrl = await asAdmin('POST', '/settings/ai/providers', {
      kind: 'OPENAI_COMPATIBLE',
      name: 'x',
      apiKey: 'k',
    });
    expect(noUrl.status).toBe(400);
  });

  test('the first Approved Model is the default; making another the default moves it', async () => {
    const { best, fast } = await twoProviders();
    expect(best.isDefault).toBe(true);
    expect(fast.isDefault).toBe(false);

    const res = await asAdmin<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${fast.id}`,
      {
        isDefault: true,
      },
    );
    expect(res.body.isDefault).toBe(true);
    const defaults = await db.approvedModel.findMany({ where: { isDefault: true } });
    expect(defaults.map((m) => m.id)).toEqual([fast.id]);

    // Unsetting the default directly isn't possible: there is always one.
    expect(
      (await asAdmin('PATCH', `/settings/ai/models/${fast.id}`, { isDefault: false })).status,
    ).toBe(400);
  });

  test('a new model can be added as the default', async () => {
    const { anthropic, best } = await twoProviders();
    const haiku = await approve(anthropic.id, 'claude-haiku-4-5', 'Fast', { isDefault: true });
    expect(haiku.isDefault).toBe(true);
    expect((await db.approvedModel.findUniqueOrThrow({ where: { id: best.id } })).isDefault).toBe(
      false,
    );
    expect(haiku.position).toBe(2);
  });

  test('display names are unique', async () => {
    const { anthropic } = await twoProviders();
    const res = await asAdmin('POST', '/settings/ai/models', {
      providerId: anthropic.id,
      modelId: 'claude-haiku-4-5',
      displayName: 'Best',
    });
    expect(res.status).toBe(409);
  });

  test('deleting the default is refused until another model is made the default', async () => {
    const { best, fast } = await twoProviders();
    const refused = await asAdmin<{ message: string }>('DELETE', `/settings/ai/models/${best.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('default');
    expect(await db.approvedModel.count()).toBe(2);

    await asAdmin('PATCH', `/settings/ai/models/${fast.id}`, { isDefault: true });
    expect((await asAdmin('DELETE', `/settings/ai/models/${best.id}`)).status).toBe(204);
    expect((await asMember<AiModelsView>('GET', '/ai/models')).body.models).toEqual([
      { id: fast.id, displayName: 'Local', note: 'No data leaves', isDefault: true },
    ]);
  });

  test('a provider with Approved Models cannot be removed', async () => {
    const { anthropic, local, fast, best } = await twoProviders();
    expect((await asAdmin('DELETE', `/settings/ai/providers/${local.id}`)).status).toBe(409);
    // Move "Local" onto Anthropic, then the router can go.
    await asAdmin('PATCH', `/settings/ai/models/${fast.id}`, {
      providerId: anthropic.id,
      modelId: 'claude-haiku-4-5',
    });
    expect((await asAdmin('DELETE', `/settings/ai/providers/${local.id}`)).status).toBe(204);
    expect((await choose('chat', fast.id)).provider?.apiKey).toBe(ANTHROPIC_KEY);
    expect(best.providerId).toBe(anthropic.id);
  });

  test('a model or provider of another kind of integration is a 404', async () => {
    await twoProviders();
    const atlassian = await db.orgIntegration.create({
      data: {
        organizationId: SEED.organizationId,
        provider: 'ATLASSIAN',
        baseUrl: 'https://acme.atlassian.net',
        secretEncrypted: 'v1:x',
      },
    });
    const res = await asAdmin('POST', '/settings/ai/models', {
      providerId: atlassian.id,
      modelId: 'm',
      displayName: 'M',
    });
    expect(res.status).toBe(404);
    expect((await asAdmin('DELETE', `/settings/ai/providers/${atlassian.id}`)).status).toBe(404);
  });

  test("with Anthropic and an OpenAI-compatible provider, each Approved Model's calls go to its own provider", async () => {
    const { anthropic, local, best, fast } = await twoProviders();
    const set = await asAdmin<AiSettingsView>('PUT', '/settings/ai/tasks', {
      tasks: { CHAT: fast.id, SUMMARIES: fast.id },
    });
    expect(set.status).toBe(200);
    expect(set.body.tasks.find((t) => t.task === 'CHAT')?.approvedModelId).toBe(fast.id);

    // Choices use the default ("Best", on Anthropic) …
    const raised = await asMember('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    expect(raised.status).toBe(201);
    // … and chat uses "Local", on the custom endpoint.
    const chat = await asMember<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content: 'What does the Spec say about retries?',
    });
    expect(chat.status).toBe(201);

    const modelOf = (method: keyof AiPort) => ai.calls.find((c) => c.method === method)?.model;
    expect(modelOf('generateChoices')).toEqual({
      source: 'APPROVED_MODEL',
      approvedModelId: best.id,
      integrationId: anthropic.id,
      provider: {
        provider: 'ANTHROPIC',
        model: 'claude-opus-5-5',
        apiKey: ANTHROPIC_KEY,
        baseUrl: null,
      },
      name: 'claude-opus-5-5',
    } satisfies ModelChoice);
    expect(modelOf('chat')).toEqual({
      source: 'APPROVED_MODEL',
      approvedModelId: fast.id,
      integrationId: local.id,
      provider: {
        provider: 'OPENAI_COMPATIBLE',
        model: 'qwen-3-coder',
        apiKey: LOCAL_KEY,
        baseUrl: LOCAL_URL,
      },
      name: 'qwen-3-coder',
    } satisfies ModelChoice);

    // Every AI task maps to its Settings task.
    const port = app.get<AiPort>(AI_PORT);
    ai.calls.length = 0;
    await port.summarizeAttachment({ attachment: { title: 't', source: 'URL', text: 'x' } });
    await port.checkFeatureFit({
      project: { name: 'p' },
      feature: { title: 'f', description: '' },
      projectContext: [],
      guidelines: [],
    });
    expect(ai.calls.map((c) => [c.method, c.model?.approvedModelId])).toEqual([
      ['summarizeAttachment', fast.id],
      ['checkFeatureFit', best.id],
    ]);
  });

  test('a call may pick an Approved Model; an unknown one falls back to the task model', async () => {
    const { best, fast } = await twoProviders();
    expect((await choose('generateChoices', fast.id)).approvedModelId).toBe(fast.id);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await choose('generateChoices', unknown)).approvedModelId).toBe(best.id);

    const port = app.get<AiPort>(AI_PORT);
    await port.summarizeAttachment(
      { attachment: { title: 't', source: 'URL', text: 'x' } },
      { approvedModelId: fast.id },
    );
    expect(ai.calls.at(-1)?.model?.approvedModelId).toBe(fast.id);
  });

  test('removing a task model makes the task fall back to the default', async () => {
    const { anthropic, best } = await twoProviders();
    const haiku = await approve(anthropic.id, 'claude-haiku-4-5', 'Fast');
    await asAdmin('PUT', '/settings/ai/tasks', { tasks: { CHAT: haiku.id } });
    expect((await choose('chat')).approvedModelId).toBe(haiku.id);

    await asAdmin('DELETE', `/settings/ai/models/${haiku.id}`);
    expect((await choose('chat')).approvedModelId).toBe(best.id);

    // null sets a task back to the default; an unknown model is refused.
    await asAdmin('PUT', '/settings/ai/tasks', { tasks: { CHAT: best.id } });
    await asAdmin('PUT', '/settings/ai/tasks', { tasks: { CHAT: null } });
    expect(await db.aiTaskModel.count()).toBe(0);
    const res = await asAdmin('PUT', '/settings/ai/tasks', {
      tasks: { CHAT: '00000000-0000-4000-8000-0000000000ff' },
    });
    expect(res.status).toBe(422);
  });

  test('VORASAAN_MODEL_<TASK> still wins when set, using a connected key of that kind', async () => {
    const { anthropic, fast } = await twoProviders();
    await asAdmin('PUT', '/settings/ai/tasks', { tasks: { CHAT: fast.id } });
    process.env.VORASAAN_MODEL_CHAT = 'anthropic/claude-haiku-4-5';
    process.env.VORASAAN_MODEL_GENERATE_CHOICES = 'openai/gpt-5.6-sol';

    expect(await choose('chat')).toEqual({
      source: 'ENV',
      approvedModelId: null,
      integrationId: anthropic.id,
      provider: {
        provider: 'ANTHROPIC',
        model: 'claude-haiku-4-5',
        apiKey: ANTHROPIC_KEY,
        baseUrl: null,
      },
      name: 'anthropic/claude-haiku-4-5',
    });
    // No OpenAI provider connected: the env key applies, as before.
    expect(await choose('generateChoices')).toEqual({
      source: 'ENV',
      approvedModelId: null,
      integrationId: null,
      provider: null,
      name: 'openai/gpt-5.6-sol',
    });
    const view = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(view.body.tasks.find((t) => t.task === 'CHAT')?.envOverrides).toEqual([
      'VORASAAN_MODEL_CHAT',
    ]);
    expect(view.body.tasks.find((t) => t.task === 'SUMMARIES')?.envOverrides).toEqual([]);
  });

  test('"Test" checks one Approved Model with a short call and reports the provider error', async () => {
    const { fast } = await twoProviders();
    const tested: unknown[] = [];
    connection.tester = async (provider) => {
      tested.push(provider);
    };
    const ok = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${fast.id}/test`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, message: 'Connected to qwen-3-coder' });
    expect(tested).toEqual([
      {
        provider: 'OPENAI_COMPATIBLE',
        model: 'qwen-3-coder',
        apiKey: LOCAL_KEY,
        baseUrl: LOCAL_URL,
      },
    ]);

    connection.tester = async () => {
      throw new Error('Request failed', {
        cause: new Error(`Incorrect API key provided: ${LOCAL_KEY}`),
      });
    };
    const failed = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${fast.id}/test`);
    expect(failed.body).toEqual({
      ok: false,
      message: 'Incorrect API key provided: …',
      latencyMs: null,
    });
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect((await asAdmin('POST', `/settings/ai/models/${missing}/test`)).status).toBe(404);
  });
});
