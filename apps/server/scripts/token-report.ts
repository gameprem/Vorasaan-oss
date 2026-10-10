// Tokens per AI task, with the eval guard (ticket 0076). Not part of `bun run test`.
//   bun run tokens:tasks                              eval cases and the product's own calls
//   bun run tokens:tasks --out before.json            ...and keep them as JSON
//   bun run tokens:tasks --compare before.json        tokens before/after, and any lower score
//   bun run tokens:tasks --cases-only                 only the checked-in eval cases (no database)
//
// Every prompt is rendered exactly as MastraAiPort would send it (`TASK_PROMPTS`) and sized
// by the script-aware estimate (ticket 0059); the FakeAiPort answers. The product's calls run
// on the small large Organization (ticket 0073) in TOKENS_DATABASE_URL, whose name must end
// in _bench (default vorasaan_tokens_bench), re-seeded on every run so two runs compare.
// Scores here are what the fake can show (valid answers, kept texts, injections not
// followed, the replay's similarity); a real model is checked with `bun run eval:*`.
import 'reflect-metadata';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@vorasaan/db';
import type { PromptMeasure } from '../src/evals/prompt-tokens.ts';
import {
  compareReports,
  formatReport,
  measureEvalCases,
  summarizeCases,
  type TokenReport,
} from '../src/evals/token-report.ts';
import { measuringEngine, runTokenScenarios } from '../src/evals/token-scenarios.ts';
import {
  LARGE_ORG_NOW,
  LARGE_ORG_SCALES,
  seedLargeOrganization,
} from '../src/perf/large-organization.ts';
import { createTestApp } from '../src/test/app.ts';
import { prepareDatabase, truncateAll } from '../src/test/database.ts';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    compare: { type: 'string' },
    'cases-only': { type: 'boolean', default: false },
  },
});
const repoRoot = resolve(import.meta.dir, '../../..');

const report: TokenReport = { cases: summarizeCases(await measureEvalCases()), scenarios: null };

if (!args['cases-only']) {
  const databaseUrl =
    process.env.TOKENS_DATABASE_URL ??
    'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_tokens_bench';
  process.env.VORASAAN_SECRET_KEY ||= 'bench-secret-key-for-vorasaan-benchmarks';
  // The chat apps, the escalation job and the evals' own runs stay quiet.
  await prepareDatabase(databaseUrl);
  const db = createPrismaClient(databaseUrl);
  const measures: PromptMeasure[] = [];
  const testApp = await createTestApp({ databaseUrl, engine: measuringEngine(measures) });
  await truncateAll(db);
  await seedLargeOrganization(db, { scale: LARGE_ORG_SCALES.small });
  testApp.clock.set(LARGE_ORG_NOW);
  try {
    report.scenarios = await runTokenScenarios(testApp, db, measures);
  } finally {
    await testApp.receipts.drain();
    await testApp.app.close();
    await db.$disconnect();
  }
}

console.log(formatReport(report));
if (args.out) {
  const path = resolve(repoRoot, args.out);
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWritten to ${path}`);
}
if (args.compare) {
  const before = (await Bun.file(resolve(repoRoot, args.compare)).json()) as TokenReport;
  const { table, lower } = compareReports(before, report);
  console.log(`\n## Compared with ${args.compare}\n\n${table}`);
  console.log(
    lower.length
      ? `\nLower scores (the change is not kept):\n${lower.map((l) => `- ${l}`).join('\n')}`
      : '\nNo score is lower.',
  );
  if (lower.length) process.exitCode = 1;
}
process.exit();
