import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import type { AiSettingsView, AiTestResult, LoginResult, SetupStatus } from '@vorasaan/shared';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';

const body = {
  organizationName: 'Acme Bank',
  admin: { name: 'Nok', email: 'Nok@AcmeBank.test', password: 'correct-horse-battery' },
  ai: {
    provider: 'OPENAI_COMPATIBLE',
    model: 'cc/claude-opus-5-5',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: '9router-token',
  },
};

describe('First-boot setup', () => {
  let app: NestFastifyApplication;
  let connection: TestApp['connection'];
  let db: PrismaClient;

  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: object, token?: string) => {
    const res = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    connection.tester = async () => {};
  });

  test('a fresh install needs setup', async () => {
    expect((await call<SetupStatus>('GET', '/setup/status')).body).toEqual({ needsSetup: true });
  });

  test('the wizard can test the provider before any Admin exists', async () => {
    const res = await call<AiTestResult>('POST', '/setup/test-ai', body.ai);
    expect(res.body.ok).toBe(true);
  });

  test('setup creates the Organization, the Admin and the provider, and signs in', async () => {
    const res = await call<LoginResult>('POST', '/setup', body);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Nok', email: 'nok@acmebank.test' });

    const membership = await db.orgMembership.findFirstOrThrow({ include: { organization: true } });
    expect(membership).toMatchObject({ role: 'ADMIN', organization: { name: 'Acme Bank' } });

    const ai = await call<AiSettingsView>('GET', '/settings/ai', undefined, res.body.token);
    expect(ai.body).toMatchObject({
      configured: true,
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://localhost:20128/v1',
      apiKeyHint: '…oken',
    });

    expect((await call<SetupStatus>('GET', '/setup/status')).body).toEqual({ needsSetup: false });
  });

  test('setup runs exactly once, and test-ai closes with it', async () => {
    expect((await call('POST', '/setup', body)).status).toBe(201);
    expect((await call('POST', '/setup', body)).status).toBe(409);
    expect((await call('POST', '/setup/test-ai', body.ai)).status).toBe(409);
    expect(await db.organization.count()).toBe(1);
  });

  test('setup requires an API key and a strong-enough password', async () => {
    const noKey = { ...body, ai: { ...body.ai, apiKey: undefined } };
    expect((await call('POST', '/setup', noKey)).status).toBe(400);
    const weak = { ...body, admin: { ...body.admin, password: 'short' } };
    expect((await call('POST', '/setup', weak)).status).toBe(400);
    expect(await db.organization.count()).toBe(0);
  });
});
