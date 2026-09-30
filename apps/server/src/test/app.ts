import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AI_PORT } from '../ai/ai.port.ts';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { AppModule } from '../app.module.ts';
import { prepareTestDatabase, testDatabaseUrl } from './database.ts';

export type TestApp = { app: NestFastifyApplication; ai: FakeAiPort };

/** Boots the real app against the test database, with FakeAiPort, ready for `app.inject()`. */
export async function createTestApp(): Promise<TestApp> {
  await prepareTestDatabase();
  process.env.DATABASE_URL = testDatabaseUrl;
  const ai = new FakeAiPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AI_PORT)
    .useValue(ai)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, ai };
}
