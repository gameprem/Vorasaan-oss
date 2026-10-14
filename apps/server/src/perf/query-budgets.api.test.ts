import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';
import type { AiUsageView } from '@vorasaan/shared';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { measure, type Scenario, type ScenarioResult } from './bench.ts';
import { LARGE_ORG_NOW, LARGE_ORG_SCALES, seedLargeOrganization } from './large-organization.ts';
import { AI_USAGE_URL, hotPaths, QUERY_BUDGETS, snapshotBenchState } from './scenarios.ts';

/**
 * Every hot path the benchmark measures has a query budget (ticket 0074), checked here on
 * the small scale of the large Organization: the counts don't grow with the data, so a
 * request over its budget is a new query per row or another round trip.
 */
describe('Query budgets of the hot paths (ticket 0074)', () => {
  let testApp: TestApp;
  let db: PrismaClient;
  let scenarios: Scenario[];
  const results = new Map<string, ScenarioResult>();
  let usage: AiUsageView | undefined;

  beforeAll(async () => {
    testApp = await createTestApp();
    db = createTestPrisma();
    await truncateAll(db);
    await seedLargeOrganization(db, { scale: LARGE_ORG_SCALES.small });
    await snapshotBenchState(db);
    testApp.clock.set(LARGE_ORG_NOW);
    ({ scenarios } = await hotPaths(testApp, db, { iterations: 1 }));
    for (const scenario of scenarios) {
      results.set(scenario.name, await measure(scenario, (run) => testApp.recordQueries(run)));
    }
    usage = (await as(testApp.app, SEED.users.pim.id)<AiUsageView>('GET', AI_USAGE_URL)).body;
  }, 120_000);

  afterAll(async () => {
    testApp.clock.reset();
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS bench CASCADE');
    await truncateAll(db);
    await db.$disconnect();
    await testApp.app.close();
  });

  test('every measured endpoint and job has a budget, and stays within it', () => {
    expect(scenarios.length).toBe(16);
    for (const scenario of scenarios) {
      const result = results.get(scenario.name);
      expect(scenario.queryBudget, scenario.name).toBeGreaterThan(0);
      expect(result?.queries.max, scenario.name).toBeLessThanOrEqual(scenario.queryBudget ?? 0);
      expect(result?.overBudget, scenario.name).toBe(false);
      expect(result?.nPlusOne, scenario.name).toBe(false);
    }
    // The AI usage dashboard read Receipts of decided requests: its budget was exercised too.
    expect(usage?.totals.calls).toBeGreaterThan(100);
    expect(usage?.costPerDecision.decisions).toBeGreaterThan(10);
    expect(usage?.redraftsBeforeApproval.length).toBeGreaterThan(0);
    // The escalation job had steps to take: its budget was really exercised.
    expect(results.get('Escalation job (every open request)')?.queries.max).toBeGreaterThan(5);
  });

  test('a request that sends one statement more than its budget fails it', async () => {
    const inbox = scenarios.find((s) => s.name === 'GET /inbox');
    if (!inbox) throw new Error('No Inbox scenario');
    const sent = results.get(inbox.name)?.queries.max ?? 0;
    expect(sent).toBeGreaterThan(0);
    const result = await measure(
      { ...inbox, iterations: 1, warmup: 0, queryBudget: sent - 1 },
      (run) => testApp.recordQueries(run),
    );
    expect(result.overBudget).toBe(true);
    expect(QUERY_BUDGETS.inbox).toBeGreaterThanOrEqual(sent);
  });
});
