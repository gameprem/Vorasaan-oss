// The performance benchmark (ticket 0073). Not part of `bun run test`.
//   bun run bench                                   the baseline: the large Organization
//   bun run bench --scale medium                    what CI runs (a tenth of it)
//   bun run bench --compare docs/performance-baseline.json
//
// It seeds the large Organization (50 Projects, 500 Features, 20,000 Decision Requests,
// 200,000 embedded chunks; minutes) into its own database, BENCH_DATABASE_URL, whose name
// must end in _bench (default: vorasaan_bench next to the dev database), and keeps it for
// the next run while it still holds that scale. Then it boots the server in-process (the
// test app: FakeAiPort, FakeEmbeddingPort, the clock set to the data's "now") and measures
// each hot path: p50, p95, SQL statements per run, their database time, and the statement
// repeated most (an N+1). It prints a Markdown table and writes the same as JSON.
//
// Options:
//   --scale small|medium|large   dataset size (default large)
//   --seed N                     the random seed (default 73)
//   --iterations N               runs per request (default 30; the escalation job a fifth)
//   --reseed                     rebuild the dataset even if it is already there
//   --seed-only                  build the dataset and stop
//   --out PATH                   where to write the JSON, and the table next to it as .md
//                                (default <repo>/bench-results/<scale>-<time>.json)
//   --compare PATH               a previous JSON to compare p95 and query counts against
//   --only TEXT                  measure only the scenarios whose name contains TEXT
// (Relative paths are from the repository root.)
import 'reflect-metadata';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@vorasaan/db';
import {
  compare,
  formatComparison,
  formatTable,
  measure,
  type ScenarioResult,
} from '../src/perf/bench.ts';
import {
  countLargeOrganization,
  LARGE_ORG_NOW,
  LARGE_ORG_SCALES,
  LARGE_ORG_SEED,
  type LargeOrgScaleName,
  seedLargeOrganization,
} from '../src/perf/large-organization.ts';
import {
  clearBenchActivity,
  hasBenchState,
  hotPaths,
  restoreBenchState,
  snapshotBenchState,
} from '../src/perf/scenarios.ts';
import { createTestApp } from '../src/test/app.ts';
import { prepareDatabase, truncateAll } from '../src/test/database.ts';

const { values: args } = parseArgs({
  options: {
    scale: { type: 'string', default: 'large' },
    seed: { type: 'string', default: String(LARGE_ORG_SEED) },
    iterations: { type: 'string', default: '30' },
    reseed: { type: 'boolean', default: false },
    'seed-only': { type: 'boolean', default: false },
    out: { type: 'string' },
    compare: { type: 'string' },
    only: { type: 'string' },
  },
});

const scaleName = args.scale as LargeOrgScaleName;
const scale = LARGE_ORG_SCALES[scaleName];
if (!scale) {
  console.error(`Unknown --scale ${args.scale}: use ${Object.keys(LARGE_ORG_SCALES).join(', ')}`);
  process.exit(2);
}
const seedValue = Number(args.seed);
const iterations = Math.max(1, Number(args.iterations));
const repoRoot = resolve(import.meta.dir, '../../..');
const databaseUrl =
  process.env.BENCH_DATABASE_URL ?? 'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_bench';
// The seed encrypts the embeddings key; the app must decrypt it with the same key.
process.env.VORASAAN_SECRET_KEY ||= 'bench-secret-key-for-vorasaan-benchmarks';

const log = (line: string) => console.log(line);

await prepareDatabase(databaseUrl);
const db = createPrismaClient(databaseUrl);

// ── The dataset ──────────────────────────────────────────────────────────────
const expected = {
  projects: scale.projects,
  features: scale.projects * scale.featuresPerProject,
  decisionRequests: scale.projects * scale.featuresPerProject * scale.requestsPerFeature,
  chunks: scale.chunks,
};
const current = await countLargeOrganization(db);
const ready =
  !args.reseed &&
  (await hasBenchState(db)) &&
  Object.entries(expected).every(([k, v]) => current[k as keyof typeof expected] === v);
let counts = current;
if (ready) {
  log(`Reusing the ${scaleName} dataset in ${new URL(databaseUrl).pathname.slice(1)}`);
} else {
  log(`Seeding the ${scaleName} Organization (seed ${seedValue})...`);
  const start = performance.now();
  await truncateAll(db);
  counts = (await seedLargeOrganization(db, { scale, seed: seedValue, log })).counts;
  await snapshotBenchState(db);
  log(`Seeded in ${Math.round((performance.now() - start) / 1000)} s`);
}
log(JSON.stringify(counts));
if (args['seed-only']) {
  await db.$disconnect();
  process.exit(0);
}
await restoreBenchState(db);
await clearBenchActivity(db);

// ── pg_stat_statements, when the server loads it (docs/performance.md) ───────
let pgStatStatements = false;
try {
  await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  await db.$queryRawUnsafe('SELECT pg_stat_statements_reset()');
  pgStatStatements = true;
} catch {
  log('pg_stat_statements is not loaded: see docs/performance.md to turn it on');
}

// ── Measure ──────────────────────────────────────────────────────────────────
const testApp = await createTestApp({ databaseUrl });
testApp.clock.set(LARGE_ORG_NOW);
const { scenarios, retrievalFoundNeedle } = await hotPaths(testApp, db, { iterations });
if (!retrievalFoundNeedle) log('Warning: retrieval did not find the fixture needle paragraph');

const results: ScenarioResult[] = [];
const only = args.only?.toLowerCase();
for (const scenario of scenarios) {
  if (only && !scenario.name.toLowerCase().includes(only)) continue;
  const start = performance.now();
  const result = await measure(scenario, (run) => testApp.recordQueries(run));
  results.push(result);
  log(
    `  ${result.name}: p50 ${result.ms.p50} ms, p95 ${result.ms.p95} ms, ` +
      `${result.queries.max} queries (${Math.round((performance.now() - start) / 1000)} s)`,
  );
}

let topStatements: unknown[] = [];
if (pgStatStatements) {
  topStatements = await db.$queryRawUnsafe(
    `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query, calls,
            round(total_exec_time::numeric, 1)::float8 AS total_ms,
            round(mean_exec_time::numeric, 3)::float8 AS mean_ms, rows
     FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
     ORDER BY total_exec_time DESC LIMIT 15`,
  );
}

const [pg] = await db.$queryRaw<{ version: string; vector: string | null }[]>`
  SELECT version() AS version,
         (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`;
const report = {
  ticket: '0074',
  createdAt: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    bun: Bun.version,
    postgres: pg?.version ?? 'unknown',
    pgvector: pg?.vector ?? null,
  },
  dataset: { scale: scaleName, seed: seedValue, now: LARGE_ORG_NOW.toISOString(), counts },
  iterations,
  retrievalFoundNeedle,
  results,
  pgStatStatements: pgStatStatements ? topStatements : null,
};

const comparison = args.compare
  ? formatComparison(
      compare(
        ((await Bun.file(resolve(repoRoot, args.compare)).json()) as typeof report).results,
        results,
      ),
    )
  : null;
const markdown = [
  `## Benchmark: ${scaleName} dataset (seed ${seedValue}), ${iterations} runs each`,
  `${report.machine.cpu}, ${report.machine.cores} cores, ${report.machine.memoryGb} GB; ` +
    `${report.machine.postgres.split(',')[0]}, pgvector ${report.machine.pgvector}; Bun ${Bun.version}`,
  formatTable(results),
  ...(comparison ? [`### Against ${args.compare}`, comparison] : []),
].join('\n\n');
console.log(`\n${markdown}\n`);

const out = args.out
  ? resolve(repoRoot, args.out)
  : resolve(repoRoot, `bench-results/${scaleName}-${report.createdAt.replace(/[:.]/g, '-')}.json`);
await mkdir(dirname(out), { recursive: true });
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
await Bun.write(out.replace(/\.json$/, '.md'), `${markdown}\n`);
log(`Wrote ${out} and its .md table`);

await testApp.app.close();
await db.$disconnect();
process.exit(0);
