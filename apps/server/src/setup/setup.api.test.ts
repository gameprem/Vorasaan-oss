import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import {
  type AiSettingsView,
  type AiTestResult,
  type LoginResult,
  SETUP_TOKEN_HEADER,
  type SetupStatus,
} from '@vorasaan/shared';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { SetupTokenService } from './setup-token.service.ts';

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
  let tokens: SetupTokenService;
  /** The Setup Token the server generated for this test (as if read from its log). */
  let setupToken: string;

  const call = async <T>(
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}), headers });
    return {
      status: res.statusCode,
      raw: res.body,
      body: (res.body ? res.json() : undefined) as T,
    };
  };
  /** A setup call carrying a Setup Token; the generated one unless another is given. */
  const withToken = (token = setupToken) => ({ [SETUP_TOKEN_HEADER]: token });

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    db = createTestPrisma();
    tokens = app.get(SetupTokenService);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    connection.tester = async () => {};
    connection.calls = 0;
    // A fresh install: the server arms a new Setup Token at startup.
    delete process.env.VORASAAN_SETUP_TOKEN;
    setupToken = tokens.arm() as string;
  });

  afterEach(() => {
    delete process.env.VORASAAN_SETUP_TOKEN;
  });

  test('a fresh install needs setup, and the status never shows the Setup Token', async () => {
    const res = await call<SetupStatus>('GET', '/setup/status');
    expect(res.body).toEqual({ needsSetup: true });
    expect(res.raw).not.toContain(setupToken);
  });

  test('the generated Setup Token is long and URL-safe', () => {
    expect(setupToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(tokens.arm()).not.toBe(setupToken);
  });

  test('setup without a Setup Token, or with a wrong one, is refused and creates nothing', async () => {
    const none = await call<{ message: string }>('POST', '/setup', body);
    expect(none.status).toBe(401);
    const wrong = await call<{ message: string }>('POST', '/setup', body, withToken('nope'));
    expect(wrong.status).toBe(401);
    // Almost right is just as wrong, and the message is the same either way.
    const close = await call<{ message: string }>(
      'POST',
      '/setup',
      body,
      withToken(`${setupToken.slice(0, -1)}x`),
    );
    expect(close.status).toBe(401);
    expect(close.body.message).toBe(none.body.message);
    expect(wrong.body.message).toBe(none.body.message);

    expect(await db.organization.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  test('the token is checked before the body, so a bad body without one is still 401', async () => {
    expect((await call('POST', '/setup', { nothing: true })).status).toBe(401);
  });

  test('test-ai needs the Setup Token too', async () => {
    expect((await call('POST', '/setup/test-ai', body.ai)).status).toBe(401);
    expect((await call('POST', '/setup/test-ai', body.ai, withToken('nope'))).status).toBe(401);
    expect(connection.calls).toBe(0);

    const res = await call<AiTestResult>('POST', '/setup/test-ai', body.ai, withToken());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(connection.calls).toBe(1);
  });

  test('setup creates the Organization, the Admin, the first provider and the default model, and signs in', async () => {
    const res = await call<LoginResult>('POST', '/setup', body, withToken());
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Nok', email: 'nok@acmebank.test' });

    const membership = await db.orgMembership.findFirstOrThrow({ include: { organization: true } });
    expect(membership).toMatchObject({ role: 'ADMIN', organization: { name: 'Acme Bank' } });

    const ai = await call<AiSettingsView>('GET', '/settings/ai', undefined, {
      authorization: `Bearer ${res.body.token}`,
    });
    expect(ai.body.providers).toEqual([
      {
        id: expect.any(String),
        kind: 'OPENAI_COMPATIBLE',
        name: 'Custom endpoint',
        baseUrl: 'http://localhost:20128/v1',
        apiKeyHint: '…oken',
        modelCount: 1,
      },
    ]);
    expect(ai.body.models).toEqual([
      expect.objectContaining({
        providerId: ai.body.providers[0]?.id,
        modelId: 'cc/claude-opus-5-5',
        displayName: 'cc/claude-opus-5-5',
        isDefault: true,
      }),
    ]);

    expect((await call<SetupStatus>('GET', '/setup/status')).body).toEqual({ needsSetup: false });
  });

  test('setup runs exactly once, and test-ai closes with it', async () => {
    expect((await call('POST', '/setup', body, withToken())).status).toBe(201);
    expect((await call('POST', '/setup', body, withToken())).status).toBe(409);
    expect((await call('POST', '/setup/test-ai', body.ai, withToken())).status).toBe(409);
    expect(await db.organization.count()).toBe(1);
  });

  test('two setups at once with the right token: exactly one Organization', async () => {
    const [a, b] = await Promise.all([
      call('POST', '/setup', body, withToken()),
      call('POST', '/setup', { ...body, organizationName: 'Other' }, withToken()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db.organization.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
  });

  test('the Setup Token is spent once setup completes, even if the database is emptied later', async () => {
    expect((await call('POST', '/setup', body, withToken())).status).toBe(201);
    await truncateAll(db);
    // Needs setup again, but only a restart (a new token) opens it.
    expect((await call<SetupStatus>('GET', '/setup/status')).body).toEqual({ needsSetup: true });
    expect((await call('POST', '/setup', body, withToken())).status).toBe(401);
    expect(await db.organization.count()).toBe(0);
  });

  test('an operator-provided VORASAAN_SETUP_TOKEN works, and is never announced', async () => {
    const configured = 'operator-chosen-setup-token-0062';
    process.env.VORASAAN_SETUP_TOKEN = configured;
    expect(tokens.arm()).toBeNull();
    const announcement = tokens.announcement('https://vorasaan.example.com') ?? '';
    expect(announcement).toContain('VORASAAN_SETUP_TOKEN');
    expect(announcement).not.toContain(configured);

    // The old generated token no longer works; the configured one does.
    expect((await call('POST', '/setup', body, withToken(setupToken))).status).toBe(401);
    expect((await call('POST', '/setup', body, withToken(configured))).status).toBe(201);
  });

  test('a short VORASAAN_SETUP_TOKEN is refused at startup', () => {
    process.env.VORASAAN_SETUP_TOKEN = 'short';
    expect(() => tokens.arm()).toThrow(/at least 20 characters/);
  });

  test('wrong tokens are rate-limited: after 10 misses even the right one waits', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/setup', body, withToken(`guess-${i}`))).status).toBe(401);
    }
    expect((await call('POST', '/setup', body, withToken())).status).toBe(429);
    expect((await call('POST', '/setup/test-ai', body.ai, withToken())).status).toBe(429);
    expect(await db.organization.count()).toBe(0);
    // A restart (a new token) starts over.
    setupToken = tokens.arm() as string;
    expect((await call('POST', '/setup', body, withToken())).status).toBe(201);
  });

  test('setup requires an API key and a strong-enough password', async () => {
    const noKey = { ...body, ai: { ...body.ai, apiKey: undefined } };
    expect((await call('POST', '/setup', noKey, withToken())).status).toBe(400);
    const weak = { ...body, admin: { ...body.admin, password: 'short' } };
    expect((await call('POST', '/setup', weak, withToken())).status).toBe(400);
    expect(await db.organization.count()).toBe(0);
  });
});
