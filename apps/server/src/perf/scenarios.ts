import type { PrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';
import { type ConversationView, ESCALATION_STEPS } from '@vorasaan/shared';
import { CONTEXT_CEILINGS, RETRIEVAL_TOP_K } from '../ai/context-budget.ts';
import { ChatCardsService } from '../chat-apps/chat-cards.service.ts';
import { ESCALATION_BATCH_SIZE } from '../response-windows/escalation.job.ts';
import { ContextRetriever } from '../retrieval/context-retriever.ts';
import { NEEDLE_PARAGRAPH, NEEDLE_QUESTION } from '../retrieval/large-project.fixture.ts';
import type { TestApp } from '../test/app.ts';
import { as } from '../test/http.ts';
import type { Scenario } from './bench.ts';
import { LARGE_ORG_NOW } from './large-organization.ts';

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

/**
 * The most SQL statements each hot path may send (ticket 0074), checked by
 * `query-budgets.api.test.ts` and flagged by the benchmark. They are the counts after
 * 0074's changes, which don't grow with the data: going over one means a new query per
 * row (an N+1) or another round trip on a hot path. Raise one only on purpose.
 */
export const QUERY_BUDGETS = {
  inbox: 15,
  featurePage: 32,
  // One more than 0074's 5 since ticket 0050: the Feature's target Platforms, one query
  // run alongside the Feature's own (Prisma would load the link table and the Platforms
  // as two through an include).
  feature: 6,
  specVersions: 6,
  decisionLog: 9,
  roleOwners: 4,
  attachments: 7,
  // Retrieval runs two searches; each may add a keyword top-up when vectors find fewer than k.
  retrieval: 27,
  decisionStats: 12,
  // Its context includes the same retrieval. Two more since ticket 0052: a Feature
  // Conversation reads its target Platforms and latest Spec for the missing sections, run
  // alongside the foundation.
  chatTurn: 83,
  // Identity, Admin check, the Organization, then four aggregates at once (ticket 0075).
  aiUsage: 8,
  // Coverage (ticket 0051), each a fixed few queries run together however many Features,
  // Platforms and Blockers there are. A Feature's: identity, then the Feature, its targets,
  // its latest Spec Version, its Team's roles and its open Blockers (their Choices are one
  // more). A Project's: identity and the Project's access check, then its Platforms, Features,
  // targets, each Feature's latest Spec Version (one statement), its Teams' roles and the
  // open Blockers with their Choices.
  featureCoverage: 7,
  projectCoverage: 11,
} as const;

/**
 * The escalation job's budget grows only with its batches, never per request: the
 * query for what is due, the calendar once, and a fixed few per batch of
 * ESCALATION_BATCH_SIZE (lock, re-read, Delegations, Tech Leads, Recipients,
 * Notifications, names, history, the update, COMMIT, and the chat apps' look-up).
 */
export function escalationQueryBudget(due: number): number {
  return 3 + 14 * Math.ceil(due / ESCALATION_BATCH_SIZE);
}
const FEATURE = SEED.featureId;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The AI usage dashboard over the 90 days up to the data's "now" (ticket 0075). */
export const AI_USAGE_URL = `/settings/ai/usage?from=${new Date(
  LARGE_ORG_NOW.getTime() - 89 * DAY_MS,
)
  .toISOString()
  .slice(0, 10)}&to=${LARGE_ORG_NOW.toISOString().slice(0, 10)}`;
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

  const featurePage: [string, number][] = [
    [`/features/${FEATURE}`, QUERY_BUDGETS.feature],
    [`/features/${FEATURE}/spec-versions`, QUERY_BUDGETS.specVersions],
    [`/features/${FEATURE}/decision-log`, QUERY_BUDGETS.decisionLog],
    [`/features/${FEATURE}/role-owners`, QUERY_BUDGETS.roleOwners],
    [`/features/${FEATURE}/attachments`, QUERY_BUDGETS.attachments],
  ];

  const retriever = app.get(ContextRetriever);
  // As the Choices retrieve: the Decision Request budget, its top-k (ticket 0076).
  const retrieve = () =>
    retriever.forFeature(FEATURE, QUERY, CONTEXT_CEILINGS.decisionRequest, {
      k: RETRIEVAL_TOP_K.decisionRequest,
    });
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

  // The AI usage dashboard (ticket 0075) reads Receipts: a few per Decision Request.
  await seedUsageReceipts(db);

  const chatCards = app.get(ChatCardsService);
  // What the escalation job finds due, as seeded (its budget depends on the batches).
  await restoreBenchState(db);
  const due = await db.decisionRequest.count({
    where: {
      status: 'OPEN',
      dueAt: { lte: testApp.clock.now() },
      escalationStep: { lt: ESCALATION_STEPS },
    },
  });

  const scenarios: Scenario[] = [
    {
      name: 'GET /inbox',
      description: "Pim's Inbox: every Decision Request, Spec Proposal and Brief Proposal for her",
      run: get('/inbox'),
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.inbox,
    },
    {
      name: 'Feature page (5 requests)',
      description: `The Feature page's reads, one after another: ${featurePage.map(([url]) => url).join(', ')}`,
      run: async () => {
        for (const [url] of featurePage) await get(url)();
      },
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.featurePage,
    },
    ...featurePage.map(
      ([url, queryBudget]): Scenario => ({
        name: `GET ${url.replace(FEATURE, ':id')}`,
        description: 'One read of the Feature page',
        run: get(url),
        iterations,
        warmup: 3,
        queryBudget,
      }),
    ),
    {
      name: 'Retrieval (Feature, pgvector)',
      description:
        'ContextRetriever.forFeature with the fixture question and the Decision Request budget ' +
        `(${CONTEXT_CEILINGS.decisionRequest} tokens, top ${RETRIEVAL_TOP_K.decisionRequest}), ranked by FakeEmbeddingPort vectors`,
      run: retrieve,
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.retrieval,
    },
    {
      name: 'GET /projects/:id/decision-stats',
      description: 'Decision Lead Time of the seeded Project, default range (12 weeks)',
      run: get(`/projects/${SEED.projectId}/decision-stats`),
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.decisionStats,
    },
    {
      name: 'GET /settings/ai/usage',
      description:
        'The AI usage dashboard over 90 days: every breakdown, cost per decision, Redrafts ' +
        'before approval and the budget, from a Receipt per Choices, Spec Proposal and Redraft',
      run: get(AI_USAGE_URL),
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.aiUsage,
    },
    {
      name: 'GET /features/:id/coverage',
      description: "A Feature's Coverage: its target Platforms, each covered or missing and why",
      run: get(`/features/${FEATURE}/coverage`),
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.featureCoverage,
    },
    {
      name: 'GET /projects/:id/coverage',
      description:
        "The seeded Project's Coverage matrix: every Feature × Platform, from each Feature's " +
        'latest Spec Version, its Team and its open Blockers with their Choices',
      run: get(`/projects/${SEED.projectId}/coverage`),
      iterations,
      warmup: 3,
      queryBudget: QUERY_BUDGETS.projectCoverage,
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
      queryBudget: escalationQueryBudget(due),
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
      queryBudget: QUERY_BUDGETS.chatTurn,
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

/** Marks the Receipts `seedUsageReceipts` writes, so a rerun replaces them. */
const BENCH_USAGE_VERSION = 'bench@usage';

/**
 * Receipts for the AI usage dashboard (ticket 0075), from the large Organization's own
 * rows, so they scale with it: one for each Decision Request's Choices, one for each Spec
 * Proposal and one for each Redraft, at the times of those rows, with tokens, cache reads
 * and latencies derived from their position (the same every time), and an APPROVE outcome
 * for each approved Spec Proposal. Replaces the ones an earlier run wrote.
 */
export async function seedUsageReceipts(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `DELETE FROM "Receipt" WHERE "promptVersion" = '${BENCH_USAGE_VERSION}'`,
  );
  const columns = `(id, task, "taskKind", "promptName", "promptVersion", "modelSource", "modelName",
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "latencyMs", success,
    "proposalKind", "proposalId", redraft, "projectId", "createdAt")`;
  const usage = (n: string) => `
    1000 + (${n} % 7) * 300, 150 + (${n} % 5) * 40, (${n} % 3) * 400, 0,
    400 + (${n} % 11) * 90, (${n} % 50) <> 0`;
  await db.$executeRawUnsafe(`
    INSERT INTO "Receipt" ${columns}
    SELECT gen_random_uuid(), 'generateChoices', 'CHOICES', 'generate-choices',
      '${BENCH_USAGE_VERSION}', 'ENV', 'anthropic/bench', ${usage('n')},
      'CHOICES', d.id, 1, t."projectId", d."createdAt"
    FROM (SELECT *, row_number() OVER (ORDER BY id) AS n FROM "DecisionRequest") d
    JOIN "Feature" f ON f.id = d."featureId" JOIN "Team" t ON t.id = f."teamId"`);
  await db.$executeRawUnsafe(`
    INSERT INTO "Receipt" ${columns}
    SELECT gen_random_uuid(), 'draftSpecProposal', 'SPEC_PROPOSAL', 'draft-spec-proposal',
      '${BENCH_USAGE_VERSION}', 'ENV', 'anthropic/bench', ${usage('n')},
      'SPEC_PROPOSAL', p.id, 1, t."projectId", p."createdAt"
    FROM (SELECT *, row_number() OVER (ORDER BY id) AS n FROM "SpecProposal") p
    JOIN "Feature" f ON f.id = p."featureId" JOIN "Team" t ON t.id = f."teamId"`);
  await db.$executeRawUnsafe(`
    INSERT INTO "Receipt" ${columns}
    SELECT gen_random_uuid(), 'redraftChoices', 'CHOICES', 'redraft-choices',
      '${BENCH_USAGE_VERSION}', 'ENV', 'anthropic/bench', ${usage('n')},
      r."proposalKind", r."proposalId", r.number, t."projectId", r."createdAt"
    FROM (SELECT *, row_number() OVER (ORDER BY id) AS n FROM "Redraft") r
    JOIN "DecisionRequest" d ON r."proposalKind" = 'CHOICES' AND d.id = r."proposalId"
    JOIN "Feature" f ON f.id = d."featureId" JOIN "Team" t ON t.id = f."teamId"`);
  await db.$executeRawUnsafe(`
    INSERT INTO "ReceiptOutcome"
      (id, "receiptId", kind, "proposalKind", "proposalId", redraft, "redraftsBeforeApproval", "createdAt")
    SELECT gen_random_uuid(), r.id, 'APPROVE', 'SPEC_PROPOSAL', p.id, 1, 0, COALESCE(p."reviewedAt", p."createdAt")
    FROM "SpecProposal" p
    JOIN "Receipt" r ON r."proposalKind" = 'SPEC_PROPOSAL' AND r."proposalId" = p.id
      AND r."promptVersion" = '${BENCH_USAGE_VERSION}'
    WHERE p.status = 'APPROVED'`);
}

/** Conversations and Receipts left by earlier runs (the seed has none). */
export async function clearBenchActivity(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "Conversation"');
  await db.$executeRawUnsafe('DELETE FROM "Receipt"');
}
