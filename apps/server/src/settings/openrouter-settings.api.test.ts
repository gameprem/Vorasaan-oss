import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  type AiModelsView,
  type AiProviderView,
  type AiSettingsView,
  type AiTestResult,
  type ApprovedModelSettingsView,
  type OpenRouterModelsView,
  SETUP_TOKEN_HEADER,
} from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { pingModel } from '../ai/mastra-ai.port.ts';
import { toMastraModel } from '../ai/model-config.ts';
import { SetupTokenService } from '../setup/setup-token.service.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { type FakeOpenRouter, startFakeOpenRouter } from '../test/fake-openrouter.ts';
import { as } from '../test/http.ts';

// Ticket 0064: OpenRouter in Settings → AI models (and setup), against a local
// stand-in for OpenRouter's API.

const { pim, beam } = SEED.users;

// Unique to this file: Mastra keeps model instances per key.
const KEY = 'sk-or-v1-settings-api-test-key-6464';

const MODELS = [
  { id: 'example/fast-model', name: 'Example: Fast', context_length: 131_072 },
  { id: 'anthropic/example-model', name: 'Anthropic: Example', context_length: 200_000 },
];

describe('OpenRouter as an AI provider', () => {
  let app: NestFastifyApplication;
  let connection: TestApp['connection'];
  let db: PrismaClient;
  let fake: FakeOpenRouter;
  let previousUrl: string | undefined;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    db = createTestPrisma();
    asAdmin = as(app, pim.id);
    asMember = as(app, beam.id);
    fake = startFakeOpenRouter(KEY);
    previousUrl = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = fake.url;
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
    connection.tester = async () => {};
    connection.calls = 0;
    fake.models = MODELS;
    fake.modelsStatus = null;
    fake.requests.length = 0;
  });

  async function connectOpenRouter() {
    const res = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'OPENROUTER',
      name: 'OpenRouter',
      apiKey: KEY,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  test('an OpenRouter provider takes a name and a key only; a base URL is refused', async () => {
    const provider = await connectOpenRouter();
    expect(provider).toEqual({
      id: expect.any(String),
      kind: 'OPENROUTER',
      name: 'OpenRouter',
      baseUrl: null,
      apiKeyHint: '…6464',
      modelCount: 0,
    });

    const withUrl = await asAdmin('POST', '/settings/ai/providers', {
      kind: 'OPENROUTER',
      name: 'Elsewhere',
      apiKey: KEY,
      baseUrl: 'http://attacker.test/v1',
    });
    expect(withUrl.status).toBe(422);
    const patched = await asAdmin('PATCH', `/settings/ai/providers/${provider.id}`, {
      baseUrl: 'http://attacker.test/v1',
    });
    expect(patched.status).toBe(422);
    const rows = await db.orgIntegration.findMany({ where: { provider: 'OPENROUTER' } });
    expect(rows.map((r) => r.baseUrl)).toEqual([null]);

    // A new key is accepted; the URL stays OpenRouter's.
    const rekeyed = await asAdmin<AiProviderView>(
      'PATCH',
      `/settings/ai/providers/${provider.id}`,
      { apiKey: 'sk-or-v1-another-key-7777' },
    );
    expect(rekeyed.body).toMatchObject({ apiKeyHint: '…7777', baseUrl: null });
  });

  test('the model list loads from OpenRouter, and a picked model gets its context_length as its window', async () => {
    const provider = await connectOpenRouter();
    const list = await asAdmin<OpenRouterModelsView>(
      'GET',
      `/settings/ai/providers/${provider.id}/models`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      models: [
        { id: 'anthropic/example-model', name: 'Anthropic: Example', contextWindow: 200_000 },
        { id: 'example/fast-model', name: 'Example: Fast', contextWindow: 131_072 },
      ],
      error: null,
    });
    // The list is public: the key is never sent to fetch it.
    expect(fake.requests.every((r) => r.headers.authorization === undefined)).toBe(true);

    // Left out, the window comes from the list; given, the Admin's wins.
    const fast = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'example/fast-model',
      displayName: 'Fast',
    });
    expect(fast.status).toBe(201);
    expect(fast.body).toMatchObject({
      providerKind: 'OPENROUTER',
      modelId: 'example/fast-model',
      contextWindow: 131_072,
    });
    const own = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'anthropic/example-model',
      displayName: 'Careful',
      contextWindow: 150_000,
    });
    expect(own.body.contextWindow).toBe(150_000);

    // A new model id re-prefills from the list.
    const moved = await asAdmin<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${fast.body.id}`,
      { modelId: 'anthropic/example-model', displayName: 'Fast again' },
    );
    expect(moved.body.contextWindow).toBe(200_000);
  });

  test("when the list can't be loaded, the Admin types the model id", async () => {
    const provider = await connectOpenRouter();
    fake.modelsStatus = 503;
    const list = await asAdmin<OpenRouterModelsView>(
      'GET',
      `/settings/ai/providers/${provider.id}/models`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      models: [],
      error: 'OpenRouter answered 503 for its model list',
    });
    const typed = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'example/unlisted-model',
      displayName: 'Typed',
    });
    expect(typed.status).toBe(201);
    expect(typed.body.contextWindow).toBe(32_000);
  });

  test('only an OpenRouter provider has a model list, and only for an Admin', async () => {
    const provider = await connectOpenRouter();
    const anthropic = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: 'sk-ant-test-key-1234',
    });
    expect(
      (await asAdmin('GET', `/settings/ai/providers/${anthropic.body.id}/models`)).status,
    ).toBe(422);
    expect((await asMember('GET', `/settings/ai/providers/${provider.id}/models`)).status).toBe(
      403,
    );
    expect(
      (await asAdmin('GET', '/settings/ai/providers/00000000-0000-4000-8000-000000000000/models'))
        .status,
    ).toBe(404);
  });

  test('a call on an OpenRouter Approved Model runs on its key, with no stored URL', async () => {
    const provider = await connectOpenRouter();
    const model = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'anthropic/example-model',
      displayName: 'Best',
    });
    const choice = await app.get(AiSettingsService).chooseModel('chat', model.body.id);
    expect(choice).toMatchObject({
      source: 'APPROVED_MODEL',
      approvedModelId: model.body.id,
      provider: {
        provider: 'OPENROUTER',
        model: 'anthropic/example-model',
        apiKey: KEY,
        baseUrl: null,
      },
      contextWindow: 200_000,
    });
  });

  test('Test connection succeeds against OpenRouter and reports its error, the key masked', async () => {
    connection.tester = (provider) => pingModel(toMastraModel(provider));
    const provider = await connectOpenRouter();
    const model = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'example/fast-model',
      displayName: 'Fast',
    });
    fake.structured = { reply: 'ok' };
    const ok = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${model.body.id}/test`);
    expect(ok.body).toMatchObject({ ok: true, message: 'Connected to example/fast-model' });
    const call = fake.requests.find((r) => r.path === '/api/v1/chat/completions');
    expect(call?.headers['x-title']).toBe('Vorasaan');
    expect(call?.headers['http-referer']).toBeDefined();

    // A key the stand-in refuses, which it echoes in its error.
    const wrong = 'sk-or-v1-refused-key-for-settings-0064';
    await asAdmin('PATCH', `/settings/ai/providers/${provider.id}`, { apiKey: wrong });
    const failed = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${model.body.id}/test`);
    expect(failed.body).toEqual({
      ok: false,
      message: 'No auth credentials found for …',
      latencyMs: null,
    });
  });

  test('the key never appears in a settings response or a member view', async () => {
    const provider = await connectOpenRouter();
    await asAdmin('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'example/fast-model',
      displayName: 'Fast',
    });
    const responses = [
      await asAdmin<AiSettingsView>('GET', '/settings/ai'),
      await asAdmin('GET', '/settings/ai/providers'),
      await asAdmin('GET', '/settings/ai/models'),
      await asAdmin('GET', `/settings/ai/providers/${provider.id}/models`),
      await asMember<AiModelsView>('GET', '/ai/models'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
    const stored = await db.orgIntegration.findFirstOrThrow({ where: { provider: 'OPENROUTER' } });
    expect(stored.secretEncrypted).not.toContain(KEY);
  });

  test('an env "openrouter/…" model uses the connected OpenRouter key', async () => {
    await connectOpenRouter();
    process.env.VORASAAN_MODEL_CHAT = 'openrouter/anthropic/example-model';
    try {
      const choice = await app.get(AiSettingsService).chooseModel('chat');
      expect(choice).toMatchObject({
        source: 'ENV',
        name: 'openrouter/anthropic/example-model',
        provider: {
          provider: 'OPENROUTER',
          model: 'anthropic/example-model',
          apiKey: KEY,
          baseUrl: null,
        },
      });
    } finally {
      delete process.env.VORASAAN_MODEL_CHAT;
    }
  });
});

describe('OpenRouter in the setup wizard', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let fake: FakeOpenRouter;
  let previousUrl: string | undefined;
  let setupToken: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    fake = startFakeOpenRouter(KEY);
    previousUrl = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = fake.url;
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
    delete process.env.VORASAAN_SETUP_TOKEN;
    setupToken = app.get(SetupTokenService).arm() as string;
    fake.models = MODELS;
    fake.modelsStatus = null;
  });

  const post = async <T>(url: string, payload: object, token: string | null = setupToken) => {
    const res = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: token ? { [SETUP_TOKEN_HEADER]: token } : {},
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  test('the provider step lists OpenRouter models, with the Setup Token only', async () => {
    expect((await post('/setup/openrouter-models', {}, null)).status).toBe(401);
    const list = await post<OpenRouterModelsView>('/setup/openrouter-models', {});
    expect(list.status).toBe(200);
    expect(list.body.models.map((m) => m.id)).toEqual([
      'anthropic/example-model',
      'example/fast-model',
    ]);
  });

  test('setup with OpenRouter creates the provider and a default model with its window', async () => {
    const refused = await post('/setup', {
      organizationName: 'Acme Bank',
      admin: { name: 'Nok', email: 'nok@acmebank.test', password: 'correct-horse-battery' },
      ai: {
        provider: 'OPENROUTER',
        model: 'example/fast-model',
        apiKey: KEY,
        baseUrl: 'http://attacker.test/v1',
      },
    });
    expect(refused.status).toBe(422);
    expect(await db.organization.count()).toBe(0);

    const res = await post('/setup', {
      organizationName: 'Acme Bank',
      admin: { name: 'Nok', email: 'nok@acmebank.test', password: 'correct-horse-battery' },
      ai: { provider: 'OPENROUTER', model: 'example/fast-model', apiKey: KEY },
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const provider = await db.orgIntegration.findFirstOrThrow({
      where: { provider: 'OPENROUTER' },
    });
    expect(provider).toMatchObject({ name: 'OpenRouter', baseUrl: null });
    const model = await db.approvedModel.findFirstOrThrow({});
    expect(model).toMatchObject({
      integrationId: provider.id,
      modelId: 'example/fast-model',
      contextWindow: 131_072,
      isDefault: true,
    });
  });
});
