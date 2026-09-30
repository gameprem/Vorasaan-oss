import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../app.ts';
import { prepareTestDatabase, testDatabaseUrl } from './database.ts';

/** Boots the real app against the test database, ready for `app.inject()`. */
export async function createTestApp(): Promise<NestFastifyApplication> {
  await prepareTestDatabase();
  process.env.DATABASE_URL = testDatabaseUrl;
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
