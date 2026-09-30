import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_PASSWORD, seed } from '@vorasaan/db/seed';
import type { AccessTokenView, CreatedAccessToken, LoginResult, MeView } from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { DEV_USER_HEADER } from './identity.guard.ts';

describe('Sign-in, sessions and access tokens', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;

  const call = async <T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    opts: { token?: string; body?: object; headers?: Record<string, string> } = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      ...(opts.body ? { payload: opts.body } : {}),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  const login = (email: string, password = SEED_PASSWORD) =>
    call<LoginResult>('POST', '/auth/login', { body: { email, password } });

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    process.env.VORASAAN_DEV_AUTH = 'false';
    await truncateAll(db);
    await seed(db);
  });

  afterEach(() => {
    process.env.VORASAAN_DEV_AUTH = 'true';
  });

  test('public routes need no credentials', async () => {
    expect((await call('GET', '/health')).status).toBe(200);
  });

  test('protected routes need a token', async () => {
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'vss_nope' })).status).toBe(401);
  });

  test('login → /me → logout', async () => {
    const res = await login('pim@acme.test');
    expect(res.status).toBe(200);
    expect(res.body.token.startsWith('vss_')).toBe(true);
    expect(res.body.user).toEqual({ id: SEED.users.pim.id, name: 'Pim', email: 'pim@acme.test' });

    const me = await call<MeView>('GET', '/me', { token: res.body.token });
    expect(me.body.name).toBe('Pim');

    expect((await call('POST', '/auth/logout', { token: res.body.token })).status).toBe(204);
    expect((await call('GET', '/me', { token: res.body.token })).status).toBe(401);
  });

  test('email is case-insensitive; wrong password and unknown email look the same', async () => {
    expect((await login('PIM@acme.test')).status).toBe(200);
    const wrong = await login('pim@acme.test', 'nope-nope-nope');
    const unknown = await login('ghost@acme.test');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test('passwords are stored as argon2id hashes', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: SEED.users.pim.id } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  test('an expired session is rejected', async () => {
    const { body } = await login('pim@acme.test');
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('GET', '/me', { token: body.token })).status).toBe(401);
  });

  test('personal access tokens: create (shown once), use, list, revoke', async () => {
    const { body: session } = await login('beam@acme.test');
    const created = await call<CreatedAccessToken>('POST', '/me/tokens', {
      token: session.token,
      body: { name: 'Laptop CLI' },
    });
    expect(created.status).toBe(201);
    expect(created.body.token.startsWith('vsp_')).toBe(true);

    const viaPat = await call<MeView>('GET', '/me', { token: created.body.token });
    expect(viaPat.body.name).toBe('Beam');

    const list = await call<AccessTokenView[]>('GET', '/me/tokens', { token: session.token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty('token');
    expect(list.body[0]?.lastUsedAt).not.toBeNull();

    const stored = await db.personalAccessToken.findFirstOrThrow();
    expect(stored.tokenHash).not.toContain(created.body.token);

    expect(
      (await call('DELETE', `/me/tokens/${created.body.id}`, { token: session.token })).status,
    ).toBe(204);
    expect((await call('GET', '/me', { token: created.body.token })).status).toBe(401);
  });

  test("you can't revoke someone else's token", async () => {
    const { body: beam } = await login('beam@acme.test');
    const { body: pat } = await call<CreatedAccessToken>('POST', '/me/tokens', {
      token: beam.token,
      body: { name: 'x' },
    });
    const { body: pim } = await login('pim@acme.test');
    expect((await call('DELETE', `/me/tokens/${pat.id}`, { token: pim.token })).status).toBe(404);
  });

  test('the dev header only works with VORASAAN_DEV_AUTH=true', async () => {
    const headers = { [DEV_USER_HEADER]: SEED.users.pim.id };
    expect((await call('GET', '/me', { headers })).status).toBe(401);
    expect((await call('GET', '/dev/users')).status).toBe(404);

    process.env.VORASAAN_DEV_AUTH = 'true';
    expect((await call('GET', '/me', { headers })).status).toBe(200);
    expect((await call('GET', '/dev/users')).status).toBe(200);
  });
});
