import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AI_CONNECTION_TESTER, type AiConnectionTester } from '../ai/ai-settings.service.ts';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { AI_ENGINE } from '../ai/mastra.module.ts';
import { AppModule } from '../app.module.ts';
import { ChatCardsService } from '../chat-apps/chat-cards.service.ts';
import { ChatEventsService } from '../chat-apps/chat-events.service.ts';
import { CLOCK } from '../clock/clock.ts';
import { installVerbatimBody } from '../http/verbatim-body.ts';
import { RedraftsService } from '../redrafts/redrafts.service.ts';
import { EscalationJob } from '../response-windows/escalation.job.ts';
import { EMBEDDING_PORT_FACTORY } from '../retrieval/embedding.port.ts';
import { FakeEmbeddings } from '../retrieval/fake-embedding.port.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { beforeTruncate, prepareTestDatabase, testDatabaseUrl } from './database.ts';
import { FakeClock } from './fake-clock.ts';

export type TestApp = {
  app: NestFastifyApplication;
  ai: FakeAiPort;
  /** Controls the FakeEmbeddingPort built for the configured embeddings provider. */
  embeddings: FakeEmbeddings;
  /** Waits for background indexing; call before asserting on chunks, and before truncating. */
  drainIndexing: () => Promise<void>;
  /** What the "test connection" call does; replace per test to simulate failures. */
  connection: { tester: AiConnectionTester; calls: number };
  /** The app's clock: reads the real time until a test sets it. */
  clock: FakeClock;
  /** The escalation job, which tests run by hand (its every-minute timer is off). */
  escalation: EscalationJob;
};

/** Boots the real app against the test database, with FakeAiPort, ready for `app.inject()`. */
export async function createTestApp(): Promise<TestApp> {
  await prepareTestDatabase();
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.VORASAAN_SECRET_KEY ??= 'test-secret-key-for-vorasaan-tests';
  // Most API tests act as seeded users via the dev header; auth tests turn it off.
  process.env.VORASAAN_DEV_AUTH = 'true';
  process.env.VORASAAN_ESCALATION_JOB = 'off';
  process.env.VORASAAN_CHAT_CARDS_JOB = 'off';
  const clock = new FakeClock();
  const ai = new FakeAiPort();
  const embeddings = new FakeEmbeddings();
  const connection: TestApp['connection'] = { tester: async () => {}, calls: 0 };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(AI_ENGINE)
    .useValue(ai)
    .overrideProvider(EMBEDDING_PORT_FACTORY)
    .useValue(embeddings.factory)
    .overrideProvider(AI_CONNECTION_TESTER)
    .useValue(((provider) => {
      connection.calls++;
      return connection.tester(provider);
    }) satisfies AiConnectionTester)
    .compile();
  const adapter = new FastifyAdapter();
  installVerbatimBody(adapter.getInstance());
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const indexing = app.get(IndexingService);
  beforeTruncate.add(() => indexing.drain());
  // Chat cards and presses run in the background too (ticket 0058).
  // Redrafts are written while their request waits, and a chat press doesn't wait (0065).
  const redrafts = app.get(RedraftsService);
  beforeTruncate.add(() => redrafts.drain());
  const chatCards = app.get(ChatCardsService);
  const chatEvents = app.get(ChatEventsService);
  beforeTruncate.add(async () => {
    await chatEvents.drain();
    await chatCards.drain();
  });
  return {
    app,
    ai,
    connection,
    embeddings,
    clock,
    escalation: app.get(EscalationJob),
    drainIndexing: () => indexing.drain(),
  };
}
