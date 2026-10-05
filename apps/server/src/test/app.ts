import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPrismaClient } from '@vorasaan/db';
import type { AiPort } from '../ai/ai.port.ts';
import { AI_CONNECTION_TESTER, type AiConnectionTester } from '../ai/ai-settings.service.ts';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { AI_ENGINE } from '../ai/mastra.module.ts';
import { AppModule } from '../app.module.ts';
import { ChatCardsService } from '../chat-apps/chat-cards.service.ts';
import { ChatEventsService } from '../chat-apps/chat-events.service.ts';
import { CLOCK } from '../clock/clock.ts';
import { installVerbatimBody } from '../http/verbatim-body.ts';
import { PRISMA } from '../prisma/prisma.module.ts';
import { PromptEvalsService } from '../prompt-versions/prompt-evals.service.ts';
import { PromptProposalsService } from '../prompt-versions/prompt-proposals.service.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { RedraftsService } from '../redrafts/redrafts.service.ts';
import { EscalationJob } from '../response-windows/escalation.job.ts';
import { EMBEDDING_PORT_FACTORY } from '../retrieval/embedding.port.ts';
import { FakeEmbeddings } from '../retrieval/fake-embedding.port.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { beforeTruncate, prepareDatabase, testDatabaseUrl } from './database.ts';
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
  /** Receipts (ticket 0070): `drain()` before reading them, `purge()` runs the daily job. */
  receipts: ReceiptsService;
  /** Eval runs (ticket 0071): `drain()` waits for the runs in progress. */
  evals: PromptEvalsService;
  /**
   * The AI's prompt proposals (ticket 0072): `drain()` waits for analyses, the evals they
   * start, and the Receipts and outcomes all of it leaves.
   */
  proposals: PromptProposalsService;
  /** The escalation job, which tests run by hand (its every-minute timer is off). */
  escalation: EscalationJob;
  /**
   * The SQL statements the app sends while `run` runs, to check a read stays a fixed few,
   * and how long each took (`queries`, for the benchmark of ticket 0073).
   */
  recordQueries: <T>(
    run: () => Promise<T>,
  ) => Promise<{ result: T; sql: string[]; queries: RecordedQuery[] }>;
};

export type RecordedQuery = { sql: string; durationMs: number };

export type TestAppOptions = {
  /** Another database than the test one, such as the benchmark's (name ending in _bench). */
  databaseUrl?: string;
  /**
   * The AI engine around the fake, such as the token measurements of ticket 0076
   * (`measuringAiPort`); the fake by default. `ai` stays the fake either way.
   */
  engine?: (fake: FakeAiPort) => AiPort;
};

/** Boots the real app against the test database, with FakeAiPort, ready for `app.inject()`. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const databaseUrl = options.databaseUrl ?? testDatabaseUrl;
  await prepareDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  process.env.VORASAAN_SECRET_KEY ??= 'test-secret-key-for-vorasaan-tests';
  // Most API tests act as seeded users via the dev header; auth tests turn it off.
  process.env.VORASAAN_DEV_AUTH = 'true';
  process.env.VORASAAN_ESCALATION_JOB = 'off';
  process.env.VORASAAN_CHAT_CARDS_JOB = 'off';
  process.env.VORASAAN_RECEIPTS_JOB = 'off';
  const clock = new FakeClock();
  const ai = new FakeAiPort();
  const embeddings = new FakeEmbeddings();
  const connection: TestApp['connection'] = { tester: async () => {}, calls: 0 };
  let recording: RecordedQuery[] | null = null;
  const prisma = createPrismaClient(databaseUrl, {
    onQuery: (sql, durationMs) => recording?.push({ sql, durationMs }),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(AI_ENGINE)
    .useValue(options.engine ? options.engine(ai) : ai)
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
  // Receipts are written off the request path (ticket 0070); the Redrafts above write some.
  const receipts = app.get(ReceiptsService);
  // Eval runs (ticket 0071) run in the background and leave Receipts: they end first.
  const evals = app.get(PromptEvalsService);
  // Analyses (ticket 0072) start evals and are started by outcomes: drain them all together.
  const proposals = app.get(PromptProposalsService);
  beforeTruncate.add(() => proposals.drain());
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
    receipts,
    evals,
    proposals,
    escalation: app.get(EscalationJob),
    drainIndexing: () => indexing.drain(),
    recordQueries: async (run) => {
      const queries: RecordedQuery[] = [];
      recording = queries;
      try {
        const result = await run();
        return { result, sql: queries.map((q) => q.sql), queries };
      } finally {
        recording = null;
      }
    },
  };
}
