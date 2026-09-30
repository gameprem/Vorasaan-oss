import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { AiSettingsView, AiTestResult } from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

describe('AI provider settings', () => {
  let app: NestFastifyApplication;
  let connection: TestApp['connection'];
  let db: PrismaClient;
  let asAdmin: ReturnType<typeof as>;
  let asMember: ReturnType<typeof as>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
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
  });

  test('starts unconfigured', async () => {
    const res = await asAdmin<AiSettingsView>('GET', '/settings/ai');
    expect(res.body).toEqual({
      configured: false,
      provider: null,
      model: null,
      baseUrl: null,
      apiKeyHint: null,
    });
  });

  test('only Admins can read, save or test', async () => {
    const body = { provider: 'ANTHROPIC', model: 'claude-opus-5-5', apiKey: 'sk-ant-1234' };
    expect((await asMember('GET', '/settings/ai')).status).toBe(403);
    expect((await asMember('PUT', '/settings/ai', body)).status).toBe(403);
    expect((await asMember('POST', '/settings/ai/test', body)).status).toBe(403);
  });

  test('saves Claude API; the key is encrypted and never returned', async () => {
    const res = await asAdmin<AiSettingsView>('PUT', '/settings/ai', {
      provider: 'ANTHROPIC',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-secret-9876',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      provider: 'ANTHROPIC',
      model: 'claude-opus-5-5',
      baseUrl: null,
      apiKeyHint: '…9876',
    });
    const stored = await db.orgIntegration.findFirstOrThrow();
    expect(stored.secretEncrypted).not.toContain('sk-ant-secret');
  });

  test('switching to a custom URL + token makes it the default; the service resolves it', async () => {
    await asAdmin('PUT', '/settings/ai', {
      provider: 'ANTHROPIC',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-1',
    });
    const res = await asAdmin<AiSettingsView>('PUT', '/settings/ai', {
      provider: 'OPENAI_COMPATIBLE',
      model: 'cc/claude-opus-5-5',
      baseUrl: 'http://localhost:20128/v1',
      apiKey: '9router-token',
    });
    expect(res.body.provider).toBe('OPENAI_COMPATIBLE');

    const resolved = await app.get(AiSettingsService).resolved();
    expect(resolved).toEqual({
      provider: 'OPENAI_COMPATIBLE',
      model: 'cc/claude-opus-5-5',
      apiKey: '9router-token',
      baseUrl: 'http://localhost:20128/v1',
    });
    expect(await db.orgIntegration.count({ where: { isDefaultLlm: true } })).toBe(1);
  });

  test('editing without re-typing the key keeps the stored key', async () => {
    await asAdmin('PUT', '/settings/ai', {
      provider: 'OPENAI',
      model: 'gpt-5.6-sol',
      apiKey: 'sk-1',
    });
    await asAdmin('PUT', '/settings/ai', { provider: 'OPENAI', model: 'gpt-5.3-codex' });
    const resolved = await app.get(AiSettingsService).resolved();
    expect(resolved).toMatchObject({ model: 'gpt-5.3-codex', apiKey: 'sk-1' });
  });

  test('a new provider needs a key; a custom provider needs a URL', async () => {
    expect(
      (await asAdmin('PUT', '/settings/ai', { provider: 'ANTHROPIC', model: 'claude-opus-5-5' }))
        .status,
    ).toBe(422);
    expect(
      (
        await asAdmin('PUT', '/settings/ai', {
          provider: 'OPENAI_COMPATIBLE',
          model: 'm',
          apiKey: 'k',
        })
      ).status,
    ).toBe(400);
  });

  test('test connection reports success and the provider error', async () => {
    const body = { provider: 'ANTHROPIC', model: 'claude-opus-5-5', apiKey: 'sk-ant-1' };
    const ok = await asAdmin<AiTestResult>('POST', '/settings/ai/test', body);
    expect(ok.body).toMatchObject({ ok: true, message: 'Connected to claude-opus-5-5' });

    connection.tester = async () => {
      throw new Error('Request failed', { cause: new Error('invalid x-api-key') });
    };
    const failed = await asAdmin<AiTestResult>('POST', '/settings/ai/test', body);
    expect(failed.body).toEqual({ ok: false, message: 'invalid x-api-key', latencyMs: null });
    expect(connection.calls).toBe(2);

    // Testing never saves.
    expect(await db.orgIntegration.count()).toBe(0);
  });
});
