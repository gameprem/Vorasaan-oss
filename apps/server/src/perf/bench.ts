import type { RecordedQuery } from '../test/app.ts';

/**
 * The benchmark harness of the performance baseline (ticket 0073): runs one scenario (a
 * request, a job) a number of times and reports its p50 and p95, how many SQL statements
 * each run sends, how long they took in the database, and the statement it repeats most,
 * which is how an N+1 shows up.
 */

/** Runs `run` while recording the SQL it sends, like TestApp.recordQueries. */
export type QueryRecorder = <T>(
  run: () => Promise<T>,
) => Promise<{ result: T; queries: RecordedQuery[] }>;

/** One statement shape repeated within a single run this many times is reported as an N+1. */
export const N_PLUS_ONE_REPEATS = 10;

export type Scenario = {
  name: string;
  /** What it measures, for the report. */
  description: string;
  /** One run: a request, or a job pass. Timed, and its SQL recorded. */
  run: () => Promise<unknown>;
  /** Before each run, untimed and unrecorded: puts back what the previous run changed. */
  before?: () => Promise<void>;
  /** After each run, untimed and unrecorded: waits for work it left in the background. */
  after?: () => Promise<void>;
  iterations: number;
  warmup?: number;
  /** The most statements one run may send; more is reported as over budget. */
  queryBudget?: number;
};

export type StatementStats = { sql: string; count: number; totalMs: number };

export type ScenarioResult = {
  name: string;
  description: string;
  iterations: number;
  ms: { p50: number; p95: number; mean: number; min: number; max: number };
  /** Statements per run (the same every run for a read, unless the data changes). */
  queries: { p50: number; max: number };
  /** Time the database reported for those statements, per run. */
  dbMs: { p50: number; p95: number };
  /** The statement repeated most within one run, and how often. */
  mostRepeated: StatementStats | null;
  /** The statements that took the most database time, summed over every run. */
  topStatements: StatementStats[];
  queryBudget: number | null;
  overBudget: boolean;
  nPlusOne: boolean;
};

/** Nearest-rank percentile of `values` (0 when empty). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/** The shape of a statement: parameters and IN lists collapsed, whitespace squeezed. */
export function statementShape(sql: string): string {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?...)')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Statements grouped by shape, most frequent first. */
export function groupStatements(queries: RecordedQuery[]): StatementStats[] {
  const groups = new Map<string, StatementStats>();
  for (const q of queries) {
    const sql = statementShape(q.sql);
    const group = groups.get(sql) ?? { sql, count: 0, totalMs: 0 };
    group.count++;
    group.totalMs += q.durationMs;
    groups.set(sql, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

export async function measure(scenario: Scenario, record: QueryRecorder): Promise<ScenarioResult> {
  const timings: number[] = [];
  const counts: number[] = [];
  const dbTimes: number[] = [];
  let mostRepeated: StatementStats | null = null;
  const totals = new Map<string, StatementStats>();

  const warmup = scenario.warmup ?? 0;
  for (let i = 0; i < warmup + scenario.iterations; i++) {
    await scenario.before?.();
    let elapsed = 0;
    const { queries } = await record(async () => {
      const start = performance.now();
      await scenario.run();
      elapsed = performance.now() - start;
    });
    await scenario.after?.();
    if (i < warmup) continue;

    timings.push(elapsed);
    counts.push(queries.length);
    dbTimes.push(queries.reduce((sum, q) => sum + q.durationMs, 0));
    const groups = groupStatements(queries);
    const top = groups[0];
    if (top && (!mostRepeated || top.count > mostRepeated.count)) mostRepeated = top;
    for (const g of groups) {
      const total = totals.get(g.sql) ?? { sql: g.sql, count: 0, totalMs: 0 };
      total.count += g.count;
      total.totalMs += g.totalMs;
      totals.set(g.sql, total);
    }
  }

  const maxQueries = Math.max(0, ...counts);
  const budget = scenario.queryBudget ?? null;
  return {
    name: scenario.name,
    description: scenario.description,
    iterations: scenario.iterations,
    ms: {
      p50: round(percentile(timings, 0.5)),
      p95: round(percentile(timings, 0.95)),
      mean: round(timings.reduce((a, b) => a + b, 0) / Math.max(1, timings.length)),
      min: round(Math.min(...timings)),
      max: round(Math.max(...timings)),
    },
    queries: { p50: percentile(counts, 0.5), max: maxQueries },
    dbMs: { p50: round(percentile(dbTimes, 0.5)), p95: round(percentile(dbTimes, 0.95)) },
    mostRepeated: mostRepeated && { ...mostRepeated, totalMs: round(mostRepeated.totalMs) },
    topStatements: [...totals.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 5)
      .map((s) => ({ ...s, totalMs: round(s.totalMs) })),
    queryBudget: budget,
    overBudget: budget !== null && maxQueries > budget,
    nPlusOne: (mostRepeated?.count ?? 0) >= N_PLUS_ONE_REPEATS,
  };
}

/** The results as a Markdown table: one row per scenario. */
export function formatTable(results: ScenarioResult[]): string {
  const header = [
    '| Scenario | p50 ms | p95 ms | Queries | DB ms p50 | Most repeated | Flags |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  const rows = results.map((r) => {
    const flags = [
      r.nPlusOne ? 'N+1' : '',
      r.overBudget ? `over budget (${r.queryBudget})` : '',
    ].filter(Boolean);
    const queries =
      r.queries.p50 === r.queries.max ? `${r.queries.max}` : `${r.queries.p50}-${r.queries.max}`;
    return `| ${r.name} | ${r.ms.p50} | ${r.ms.p95} | ${queries} | ${r.dbMs.p50} | ${r.mostRepeated?.count ?? 0}× | ${flags.join(', ')} |`;
  });
  return [...header, ...rows].join('\n');
}

export type Comparison = {
  name: string;
  baselineP95: number;
  p95: number;
  /** Change in p95, in percent of the baseline (negative is faster). */
  p95Change: number;
  baselineQueries: number;
  queries: number;
};

/** Each scenario of `current` against the same one in `baseline`, when it has it. */
export function compare(baseline: ScenarioResult[], current: ScenarioResult[]): Comparison[] {
  const before = new Map(baseline.map((r) => [r.name, r]));
  return current.flatMap((r) => {
    const b = before.get(r.name);
    if (!b) return [];
    return [
      {
        name: r.name,
        baselineP95: b.ms.p95,
        p95: r.ms.p95,
        p95Change: b.ms.p95 ? round(((r.ms.p95 - b.ms.p95) / b.ms.p95) * 100) : 0,
        baselineQueries: b.queries.max,
        queries: r.queries.max,
      },
    ];
  });
}

export function formatComparison(rows: Comparison[]): string {
  return [
    '| Scenario | Baseline p95 ms | p95 ms | Change | Baseline queries | Queries |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (c) =>
        `| ${c.name} | ${c.baselineP95} | ${c.p95} | ${c.p95Change > 0 ? '+' : ''}${c.p95Change}% | ${c.baselineQueries} | ${c.queries} |`,
    ),
  ].join('\n');
}
