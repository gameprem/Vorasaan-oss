import type { PrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';
import type { ConversationView } from '@vorasaan/shared';
import { CONTEXT_CEILINGS } from '../ai/context-budget.ts';
import { ChatCardsService } from '../chat-apps/chat-cards.service.ts';
import { ContextRetriever } from '../retrieval/context-retriever.ts';
import { NEEDLE_PARAGRAPH, NEEDLE_QUESTION } from '../retrieval/large-project.fixture.ts';
import type { TestApp } from '../test/app.ts';
import { as } from '../test/http.ts';
import type { Scenario } from './bench.ts';

/**
 * The hot paths the baseline measures (ticket 0073), on the large Organization, as Pim:
 * a PO in every Team and a Role Owner of every Feature, so hers is the heaviest Inbox.
 * The Feature is "Async checkout", which carries the large-project fixture's handbook.
 */
export type HotPathOptions = {
  /** Runs per request scenario; the escalation job runs a fifth as many (at least 3). */
  iterations: number;
};

export type HotPaths = {
  scenarios: Scenario[];
  /** Whether retrieval found the fixture's needle paragraph: the ranking still works. */
  retrievalFoundNeedle: boolean;
};

const PIM = SEED.users.pim.id;
const FEATURE = SEED.featureId;
const QUERY = `${NEEDLE_QUESTION.title}\n\n${NEEDLE_QUESTION.description}`;

export async function hotPaths(
  testApp: TestApp,
  db: PrismaClient,
  { iterations }: HotPathOptions,
): Promise<HotPaths> {
  const { app } = testApp;
  const asPim = as(app, PIM);
  const get = (url: string) => async () => {
    const res = await asPim('GET', url);
    if (res.status !== 200) throw new Error(`GET ${url} answered ${res.status}`);
  };

  const featurePage = [
    `/features/${FEATURE}`,
    `/features/${FEATURE}/spec-versions`,
    `/features/${FEATURE}/decision-log`,
    `/features/${FEATURE}/role-owners`,
    `/features/${FEATURE}/attachments`,
  ];

  const retriever = app.get(ContextRetriever);
  const retrieve = () => retriever.forFeature(FEATURE, QUERY, CONTEXT_CEILINGS.decisionRequest);
  const blocks = await retrieve();
  const retrievalFoundNeedle = blocks.some((b) => b.text.includes(NEEDLE_PARAGRAPH));

  // One Feature Conversation; every run is one more turn in it.
  const started = await asPim<ConversationView>('POST', '/conversations', {
    scope: { kind: 'FEATURE', featureId: FEATURE },
    content: 'What is still open on this Feature?',
  });
  if (started.status !== 201 && started.status !== 200) {
    throw new Error(`Could not start a Conversation: ${started.status}`);
  }
  await testApp.receipts.drain();
  const conversationId = started.body.id;

  const chatCards = app.get(ChatCardsService);

  const scenarios: Scenario[] = [
    {
      name: 'GET /inbox',
      description: "Pim's Inbox: every Decision Request, Spec Proposal and Brief Proposal for her",
      run: get('/inbox'),
      iterations,
      warmup: 3,
    },
    {
      name: 'Feature page (5 requests)',
      description: `The Feature page's reads, one after another: ${featurePage.join(', ')}`,
      run: async () => {
        for (const url of featurePage) await get(url)();
      },
      iterations,
      warmup: 3,
    },
    ...featurePage.map(
      (url): Scenario => ({
        name: `GET ${url.replace(FEATURE, ':id')}`,
        description: 'One read of the Feature page',
        run: get(url),
        iterations,
        warmup: 3,
      }),
    ),
    {
      name: 'Retrieval (Feature, pgvector)',
      description:
        'ContextRetriever.forFeature with the fixture question and the Decision Request budget ' +
        `(${CONTEXT_CEILINGS.decisionRequest} tokens), ranked by FakeEmbeddingPort vectors`,
      run: retrieve,
      iterations,
      warmup: 3,
    },
    {
      name: 'GET /projects/:id/decision-stats',
      description: 'Decision Lead Time of the seeded Project, default range (12 weeks)',
      run: get(`/projects/${SEED.projectId}/decision-stats`),
      iterations,
      warmup: 3,
    },
    {
      name: 'Escalation job (every open request)',
      description:
        'EscalationJob.run() over every OPEN Decision Request due at "now", from the same state ' +
        'each run (reset before), plus the chat card dispatch it queues',
      before: () => restoreBenchState(db),
      run: async () => {
        await testApp.escalation.run();
        await chatCards.drain();
      },
      iterations: Math.max(3, Math.round(iterations / 5)),
      warmup: 1,
    },
    {
      name: 'Chat turn (fake AI)',
      description:
        'POST /conversations/:id/messages in a Feature Conversation, with FakeAiPort; its ' +
        'Receipt is written after the reply and not counted',
      run: async () => {
        const res = await asPim('POST', `/conversations/${conversationId}/messages`, {
          content: 'Which decisions changed the Spec this month?',
        });
        if (res.status !== 201 && res.status !== 200) {
          throw new Error(`A chat turn answered ${res.status}`);
        }
      },
      after: () => testApp.receipts.drain(),
      iterations,
      warmup: 2,
    },
  ];
  return { scenarios, retrievalFoundNeedle };
}

/**
 * What the escalation job changes, as seeded, in a `bench` schema next to the app's
 * tables, so every run of it starts from the same state. Taken right after seeding.
 */
export async function snapshotBenchState(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS bench CASCADE');
  await db.$executeRawUnsafe('CREATE SCHEMA bench');
  await db.$executeRawUnsafe(
    `CREATE TABLE bench.requests AS
       SELECT id, "escalationStep", "updatedAt" FROM "DecisionRequest" WHERE status = 'OPEN'`,
  );
  await db.$executeRawUnsafe('CREATE TABLE bench.recipients AS SELECT id FROM "RequestRecipient"');
  await db.$executeRawUnsafe('CREATE TABLE bench.history AS SELECT id FROM "RequestHistoryEntry"');
  await db.$executeRawUnsafe('CREATE TABLE bench.notifications AS SELECT id FROM "Notification"');
  for (const table of ['requests', 'recipients', 'history', 'notifications']) {
    await db.$executeRawUnsafe(`ALTER TABLE bench.${table} ADD PRIMARY KEY (id)`);
  }
}

export async function hasBenchState(db: PrismaClient): Promise<boolean> {
  const [row] = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('bench.requests') IS NOT NULL AS exists`;
  return Boolean(row?.exists);
}

/** Puts back the seeded escalation state, and drops what earlier benchmark runs added. */
export async function restoreBenchState(db: PrismaClient): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe(
      `DELETE FROM "RequestRecipient" r
       WHERE NOT EXISTS (SELECT 1 FROM bench.recipients b WHERE b.id = r.id)`,
    ),
    db.$executeRawUnsafe(
      `DELETE FROM "RequestHistoryEntry" h
       WHERE NOT EXISTS (SELECT 1 FROM bench.history b WHERE b.id = h.id)`,
    ),
    db.$executeRawUnsafe(
      `DELETE FROM "Notification" n
       WHERE NOT EXISTS (SELECT 1 FROM bench.notifications b WHERE b.id = n.id)`,
    ),
    db.$executeRawUnsafe('DELETE FROM "ChatCard"'),
    db.$executeRawUnsafe(
      `UPDATE "DecisionRequest" d
       SET "escalationStep" = b."escalationStep", "updatedAt" = b."updatedAt"
       FROM bench.requests b
       WHERE d.id = b.id
         AND (d."escalationStep" <> b."escalationStep" OR d."updatedAt" <> b."updatedAt")`,
    ),
  ]);
}

/** Conversations and Receipts left by earlier runs (the seed has none). */
export async function clearBenchActivity(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "Conversation"');
  await db.$executeRawUnsafe('DELETE FROM "Receipt"');
}
