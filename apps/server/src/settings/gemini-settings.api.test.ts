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
  type ProviderModelsView,
  SETUP_TOKEN_HEADER,
} from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { pingModel } from '../ai/mastra-ai.port.ts';
import { toMastraModel } from '../ai/model-config.ts';
import { SetupTokenService } from '../setup/setup-token.service.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { type FakeGemini, type FakeGeminiModel, startFakeGemini } from '../test/fake-gemini.ts';
import { as } from '../test/http.ts';

// Ticket 0080: Gemini in Settings → AI models (and setup), against a local stand-in
// for the Gemini API.

const { pim, beam } = SEED.users;

// Unique to this file: Mastra keeps model instances per key.
const KEY = 'AIza-gemini-settings-api-key-8080';

const MODELS: FakeGeminiModel[] = [
  {
    name: 'models/gemini-example-pro',
    displayName: 'Gemini Example Pro',
    inputTokenLimit: 1_048_576,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/gemini-example-flash',
    displayName: 'Gemini Example Flash',
    inputTokenLimit: 524_288,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/example-embedding',
    displayName: 'Example Embedding',
    inputTokenLimit: 2_048,
    supportedGenerationMethods: ['embedContent'],
  },
];

describe('Gemini as an AI provider', () => {
  let app: NestFastifyApplication;
  let connection: TestApp['connection'];
  let db: PrismaClient;
  let fake: FakeGemini;
  let previousUrl: string | undefined;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    db = createTestPrisma();
    asAdmin = as(app, pim.id);
    asMember = as(app, beam.id);
    fake = startFakeGemini(KEY);
    previousUrl = process.env.GOOGLE_BASE_URL;
    process.env.GOOGLE_BASE_URL = fake.url;
  });

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.GOOGLE_BASE_URL;
    else process.env.GOOGLE_BASE_URL = previousUrl;
    fake.stop();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    connection.tester = async () => {};
    connection.calls = 0;
    fake.key = KEY;
    fake.models = MODELS;
    fake.modelsStatus = null;
    fake.structured = { reply: 'ok' };
    fake.requests.length = 0;
  });

  async function connectGemini() {
    const res = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'GEMINI',
      name: 'Gemini',
      apiKey: KEY,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  test('a Gemini provider takes a name and a key only; a base URL is refused', async () => {
    const provider = await connectGemini();
    expect(provider).toEqual({
      id: expect.any(String),
      kind: 'GEMINI',
      name: 'Gemini',
      baseUrl: null,
      apiKeyHint: '…8080',
      modelCount: 0,
    });

    const withUrl = await asAdmin('POST', '/settings/ai/providers', {
      kind: 'GEMINI',
      name: 'Elsewhere',
      apiKey: KEY,
      baseUrl: 'http://attacker.test/v1beta',
    });
    expect(withUrl.status).toBe(422);
    const patched = await asAdmin('PATCH', `/settings/ai/providers/${provider.id}`, {
      baseUrl: 'http://attacker.test/v1beta',
    });
    expect(patched.status).toBe(422);
    const rows = await db.orgIntegration.findMany({ where: { provider: 'GEMINI' } });
    expect(rows.map((r) => r.baseUrl)).toEqual([null]);
    expect(rows[0]?.secretEncrypted).not.toContain(KEY);

    const rekeyed = await asAdmin<AiProviderView>(
      'PATCH',
      `/settings/ai/providers/${provider.id}`,
      { apiKey: 'AIza-another-gemini-key-9999' },
    );
    expect(rekeyed.body).toMatchObject({ apiKeyHint: '…9999', baseUrl: null });
  });

  test("the model list is the Gemini API's, read with the stored key, and a picked model gets its input token limit as its window", async () => {
    const provider = await connectGemini();
    const list = await asAdmin<ProviderModelsView>(
      'GET',
      `/settings/ai/providers/${provider.id}/models`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      models: [
        { id: 'gemini-example-flash', name: 'Gemini Example Flash', contextWindow: 524_288 },
        { id: 'gemini-example-pro', name: 'Gemini Example Pro', contextWindow: 1_048_576 },
      ],
      error: null,
    });
    expect(fake.requests.map((r) => r.headers['x-goog-api-key'])).toEqual([KEY]);

    // Left out, the window comes from the list; given, the Admin's wins.
    const flash = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-example-flash',
      displayName: 'Fast',
    });
    expect(flash.status).toBe(201);
    expect(flash.body).toMatchObject({
      providerKind: 'GEMINI',
      providerName: 'Gemini',
      modelId: 'gemini-example-flash',
      contextWindow: 524_288,
    });
    const own = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-example-pro',
      displayName: 'Careful',
      contextWindow: 200_000,
    });
    expect(own.body.contextWindow).toBe(200_000);

    // A new model id re-prefills from the list.
    const moved = await asAdmin<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${flash.body.id}`,
      { modelId: 'gemini-example-pro', displayName: 'Fast again' },
    );
    expect(moved.body.contextWindow).toBe(1_048_576);
  });

  test("when the list can't be loaded, the Admin types the model id and the window falls back", async () => {
    const provider = await connectGemini();
    fake.modelsStatus = 503;
    const list = await asAdmin<ProviderModelsView>(
      'GET',
      `/settings/ai/providers/${provider.id}/models`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      models: [],
      error: 'The Gemini API answered 503 for its model list',
    });
    // A Gemini id the known table recognizes gets its window; anything else, the default.
    const known = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-unlisted-model',
      displayName: 'Typed',
    });
    expect(known.status).toBe(201);
    expect(known.body.contextWindow).toBe(1_048_576);
    const unknown = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'example-unlisted-model',
      displayName: 'Other',
    });
    expect(unknown.body.contextWindow).toBe(32_000);
  });

  test('a refused key: the list says so, without echoing the key', async () => {
    const provider = await connectGemini();
    fake.key = 'AIza-a-different-key-the-fake-wants';
    const list = await asAdmin<ProviderModelsView>(
      'GET',
      `/settings/ai/providers/${provider.id}/models`,
    );
    expect(list.body).toEqual({
      models: [],
      error: 'The Gemini API refused the key (400) when listing its models',
    });
    expect(JSON.stringify(list.body)).not.toContain(KEY);
  });

  test('the model list is for an Admin only, and 404 for an unknown provider', async () => {
    const provider = await connectGemini();
    expect((await asMember('GET', `/settings/ai/providers/${provider.id}/models`)).status).toBe(
      403,
    );
    expect(
      (await asAdmin('GET', '/settings/ai/providers/00000000-0000-4000-8000-000000000000/models'))
        .status,
    ).toBe(404);
    const anthropic = await asAdmin<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: 'sk-ant-test-key-1234',
    });
    expect(
      (await asAdmin('GET', `/settings/ai/providers/${anthropic.body.id}/models`)).status,
    ).toBe(422);
  });

  test('a call on a Gemini Approved Model runs on its key, with no stored URL', async () => {
    const provider = await connectGemini();
    const model = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-example-pro',
      displayName: 'Best',
    });
    const choice = await app.get(AiSettingsService).chooseModel('chat', model.body.id);
    expect(choice).toMatchObject({
      source: 'APPROVED_MODEL',
      approvedModelId: model.body.id,
      provider: { provider: 'GEMINI', model: 'gemini-example-pro', apiKey: KEY, baseUrl: null },
      contextWindow: 1_048_576,
    });
  });

  test('Test connection succeeds against Gemini and reports its error, the key masked', async () => {
    connection.tester = (provider) => pingModel(toMastraModel(provider));
    const provider = await connectGemini();
    const model = await asAdmin<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-example-pro',
      displayName: 'Best',
    });
    const ok = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${model.body.id}/test`);
    expect(ok.body).toMatchObject({ ok: true, message: 'Connected to gemini-example-pro' });
    const call = fake.requests.find((r) => r.path.endsWith(':streamGenerateContent'));
    expect(call?.path).toBe('/v1beta/models/gemini-example-pro:streamGenerateContent');
    expect(call?.headers['x-goog-api-key']).toBe(KEY);

    // A key the stand-in refuses, which it echoes in its error.
    const wrong = 'AIza-refused-key-for-settings-0080';
    await asAdmin('PATCH', `/settings/ai/providers/${provider.id}`, { apiKey: wrong });
    const failed = await asAdmin<AiTestResult>('POST', `/settings/ai/models/${model.body.id}/test`);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.message).toContain('API key not valid: …');
    expect(failed.body.message).not.toContain(wrong);
  });

  test('the key never appears in a settings response or a member view', async () => {
    const provider = await connectGemini();
    await asAdmin('POST', '/settings/ai/models', {
      providerId: provider.id,
      modelId: 'gemini-example-pro',
      displayName: 'Best',
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
  });

  test('an env "google/…" model uses the connected Gemini key', async () => {
    await connectGemini();
    process.env.VORASAAN_MODEL_CHAT = 'google/gemini-example-pro';
    try {
      const choice = await app.get(AiSettingsService).chooseModel('chat');
      expect(choice).toMatchObject({
        source: 'ENV',
        name: 'google/gemini-example-pro',
        provider: { provider: 'GEMINI', model: 'gemini-example-pro', apiKey: KEY, baseUrl: null },
        contextWindow: 1_048_576,
      });
    } finally {
      delete process.env.VORASAAN_MODEL_CHAT;
    }
  });
});

describe('Gemini in the setup wizard', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let fake: FakeGemini;
  let previousUrl: string | undefined;
  let setupToken: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    fake = startFakeGemini(KEY);
    previousUrl = process.env.GOOGLE_BASE_URL;
    process.env.GOOGLE_BASE_URL = fake.url;
  });

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.GOOGLE_BASE_URL;
    else process.env.GOOGLE_BASE_URL = previousUrl;
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

  test('the provider step lists Gemini models for the typed key, with the Setup Token only', async () => {
    expect((await post('/setup/gemini-models', { apiKey: KEY }, null)).status).toBe(401);
    expect((await post('/setup/gemini-models', {})).status).toBe(400);
    const list = await post<ProviderModelsView>('/setup/gemini-models', { apiKey: KEY });
    expect(list.status).toBe(200);
    expect(list.body.models.map((m) => m.id)).toEqual([
      'gemini-example-flash',
      'gemini-example-pro',
    ]);
    expect(JSON.stringify(list.body)).not.toContain(KEY);
    // The key typed in the wizard is not stored by listing.
    expect(await db.orgIntegration.count()).toBe(0);
  });

  test('setup with Gemini creates the provider and a default model with its window', async () => {
    const refused = await post('/setup', {
      organizationName: 'Acme Bank',
      admin: { name: 'Nok', email: 'nok@acmebank.test', password: 'correct-horse-battery' },
      ai: {
        provider: 'GEMINI',
        model: 'gemini-example-flash',
        apiKey: KEY,
        baseUrl: 'http://attacker.test/v1beta',
      },
    });
    expect(refused.status).toBe(422);
    expect(await db.organization.count()).toBe(0);

    const res = await post('/setup', {
      organizationName: 'Acme Bank',
      admin: { name: 'Nok', email: 'nok@acmebank.test', password: 'correct-horse-battery' },
      ai: { provider: 'GEMINI', model: 'gemini-example-flash', apiKey: KEY },
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const provider = await db.orgIntegration.findFirstOrThrow({ where: { provider: 'GEMINI' } });
    expect(provider).toMatchObject({ name: 'Gemini', baseUrl: null });
    const model = await db.approvedModel.findFirstOrThrow({});
    expect(model).toMatchObject({
      integrationId: provider.id,
      modelId: 'gemini-example-flash',
      contextWindow: 524_288,
      isDefault: true,
    });
  });
});
