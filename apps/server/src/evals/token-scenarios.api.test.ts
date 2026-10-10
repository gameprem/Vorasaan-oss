import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@vorasaan/db';
import {
  LARGE_ORG_NOW,
  LARGE_ORG_SCALES,
  seedLargeOrganization,
} from '../perf/large-organization.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import type { PromptMeasure } from './prompt-tokens.ts';
import { PRODUCT_TOKEN_GUARD, REPLAY_SCORE_GUARD } from './token-guard.ts';
import { measuringEngine, runTokenScenarios, type ScenarioReport } from './token-scenarios.ts';

// The eval guard of ticket 0076 on the product's own calls: every workflow once on the
// small large Organization, with its real context (retrieval, the Brief, the Guidelines,
// history), the FakeAiPort answering and each prompt measured as a provider would get it.
// Tokens per task are read from the Receipts; the approved ones are replayed and scored.

describe('Tokens per AI task, from the Receipts (ticket 0076)', () => {
  let testApp: TestApp;
  let db: PrismaClient;
  let report: ScenarioReport;
  const measures: PromptMeasure[] = [];

  beforeAll(async () => {
    testApp = await createTestApp({ engine: measuringEngine(measures) });
    db = createTestPrisma();
    await truncateAll(db);
    await seedLargeOrganization(db, { scale: LARGE_ORG_SCALES.small });
    testApp.clock.set(LARGE_ORG_NOW);
    report = await runTokenScenarios(testApp, db, measures);
  }, 120_000);

  afterAll(async () => {
    testApp.clock.reset();
    await testApp.receipts.drain();
    await truncateAll(db);
    await db.$disconnect();
    await testApp.app.close();
  });

  test('every Receipt carries the measured prompt, not a fixed usage', async () => {
    const receipts = await db.receipt.findMany({
      where: { evalRunId: null },
      select: { task: true, inputTokens: true },
    });
    expect(receipts.length).toBe(measures.length);
    const measured = measures.map((m) => `${m.task}:${m.tokens}`).sort();
    expect(receipts.map((r) => `${r.task}:${r.inputTokens}`).sort()).toEqual(measured);
  });

  test('no task sends more tokens per call than after its optimizations', () => {
    expect(report.tasks.map((t): string => t.task).sort()).toEqual(
      Object.keys(PRODUCT_TOKEN_GUARD).sort(),
    );
    for (const t of report.tasks) {
      expect(t.input, t.task).toBeLessThanOrEqual(PRODUCT_TOKEN_GUARD[t.task] ?? 0);
    }
  });

  test('the replay of approved Receipts scores no lower, and retrieval still finds the needle', () => {
    expect(report.foundNeedle).toBe(true);
    for (const r of report.replay) {
      expect(r.cases, r.prompt).toBeGreaterThan(0);
      expect(r.score, r.prompt).toBeGreaterThanOrEqual(
        REPLAY_SCORE_GUARD[r.prompt as keyof typeof REPLAY_SCORE_GUARD],
      );
    }
  });
});
