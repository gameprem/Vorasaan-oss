import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { DEV_USER_HEADER } from './dev-user.guard.ts';

describe('DevUserGuard', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(() => truncateAll(db));

  test('public routes need no header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>()).toEqual({ ok: true });
  });

  test('dev user list is public', async () => {
    await db.user.create({ data: { email: 'pim@acme.test', name: 'Pim', passwordHash: 'x' } });
    const res = await app.inject({ method: 'GET', url: '/dev/users' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string }[]>().map((u) => u.name)).toEqual(['Pim']);
  });

  test('rejects a request without the header', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  test('rejects an unknown user id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { [DEV_USER_HEADER]: crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  test('resolves a known user', async () => {
    const user = await db.user.create({
      data: { email: 'pim@acme.test', name: 'Pim', passwordHash: 'x' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { [DEV_USER_HEADER]: user.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string; email: string; name: string }>()).toEqual({
      id: user.id,
      email: 'pim@acme.test',
      name: 'Pim',
    });
  });
});
