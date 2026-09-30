import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AI_PORT } from '../ai/ai.port.ts';
import { AI_CONNECTION_TESTER, type AiConnectionTester } from '../ai/ai-settings.service.ts';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { AppModule } from '../app.module.ts';
import { prepareTestDatabase, testDatabaseUrl } from './database.ts';

export type TestApp = {
  app: NestFastifyApplication;
  ai: FakeAiPort;
  /** What the "test connection" call does; replace per test to simulate failures. */
  connection: { tester: AiConnectionTester; calls: number };
};

/** Boots the real app against the test database, with FakeAiPort, ready for `app.inject()`. */
export async function createTestApp(): Promise<TestApp> {
  await prepareTestDatabase();
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.VORASAAN_SECRET_KEY ??= 'test-secret-key-for-vorasaan-tests';
  const ai = new FakeAiPort();
  const connection: TestApp['connection'] = { tester: async () => {}, calls: 0 };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AI_PORT)
    .useValue(ai)
    .overrideProvider(AI_CONNECTION_TESTER)
    .useValue(((provider) => {
      connection.calls++;
      return connection.tester(provider);
    }) satisfies AiConnectionTester)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, ai, connection };
}
