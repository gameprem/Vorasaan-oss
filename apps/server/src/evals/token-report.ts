import type { AiTask } from '../ai/ai.config.ts';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { scoreOutput } from './eval-case.ts';
import { EVAL_CASES } from './eval-sets.ts';
import { measuringAiPort, type PromptMeasure } from './prompt-tokens.ts';
import type { ScenarioReport, TaskTokens } from './token-scenarios.ts';

// The token report of ticket 0076 (`bun run tokens:tasks`): tokens per AI task on the
// checked-in eval cases and on the product's own calls (token-scenarios.ts), with the
// eval scores next to them, so a change is kept only when tokens go down and no score
// does. With the fake answering, the scores here are the structural checks a fake can
// pass; how well a real model answers is measured by hand (`bun run eval:*`).

/** One checked-in eval case: its prompt's size and its score. */
export type CaseTokens = {
  key: string;
  task: AiTask;
  thai: boolean;
  tokens: number;
  cacheable: number;
  score: number;
};

/** Every checked-in eval case, rendered as a real provider would get it, and scored. */
export async function measureEvalCases(): Promise<CaseTokens[]> {
  const out: CaseTokens[] = [];
  for (const c of EVAL_CASES) {
    let measure: PromptMeasure | undefined;
    const ai = measuringAiPort(new FakeAiPort(), {
      onMeasure: (m) => {
        measure = m;
      },
    });
    const output = await c.run(ai, { language: c.lang?.language });
    out.push({
      key: c.key,
      task: c.task,
      thai: c.lang?.language === 'th',
      tokens: measure?.tokens ?? 0,
      cacheable: measure?.cacheable ?? 0,
      score: scoreOutput(c, output).score,
    });
  }
  return out;
}

export type CaseTaskSummary = {
  task: AiTask;
  cases: number;
  tokens: number;
  cacheable: number;
  score: number;
  thaiScore: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The eval cases per task: mean prompt tokens and scores (Thai cases apart). */
export function summarizeCases(cases: CaseTokens[]): CaseTaskSummary[] {
  const order = Object.keys(TASK_SKILLS) as AiTask[];
  const tasks = [...new Set(cases.map((c) => c.task))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  return tasks.map((task) => {
    const of = cases.filter((c) => c.task === task);
    const thai = of.filter((c) => c.thai);
    return {
      task,
      cases: of.length,
      tokens: Math.round(mean(of.map((c) => c.tokens))),
      cacheable: Math.round(mean(of.map((c) => c.cacheable))),
      score: mean(of.map((c) => c.score)),
      thaiScore: thai.length ? mean(thai.map((c) => c.score)) : null,
    };
  });
}

export type TokenReport = {
  cases: CaseTaskSummary[];
  scenarios: ScenarioReport | null;
};

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function formatReport(report: TokenReport): string {
  const lines = [
    '## Checked-in eval cases (prompt tokens by the estimate, scores on the fake)',
    '',
    '| Task | Cases | Tokens | Cacheable | Score | Thai score |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.cases.map(
      (t) =>
        `| ${t.task} | ${t.cases} | ${t.tokens} | ${t.cacheable} | ${pct(t.score)} | ${t.thaiScore === null ? '-' : pct(t.thaiScore)} |`,
    ),
  ];
  if (report.scenarios) {
    lines.push(
      '',
      '## The product’s own calls (input tokens per call, from their Receipts)',
      '',
      '| Task | Calls | Input | Cacheable | Uncached |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...report.scenarios.tasks.map(
        (t) => `| ${t.task} | ${t.calls} | ${t.input} | ${t.cacheable} | ${t.uncached} |`,
      ),
      '',
      '| Replay | Cases | Input | Score |',
      '| --- | ---: | ---: | ---: |',
      ...report.scenarios.replay.map(
        (r) => `| ${r.prompt} | ${r.cases} | ${r.input} | ${pct(r.score)} |`,
      ),
      '',
      `Retrieval found the needle paragraph: ${report.scenarios.foundNeedle ? 'yes' : 'NO'}`,
    );
  }
  return lines.join('\n');
}

const change = (before: number, after: number) =>
  before
    ? `${after - before >= 0 ? '+' : ''}${(((after - before) / before) * 100).toFixed(1)}%`
    : '-';

/**
 * The guard (ticket 0076): tokens before and after per task, and every score that went
 * down. A change is kept only when this lists no lower score.
 */
export function compareReports(before: TokenReport, after: TokenReport) {
  const lower: string[] = [];
  const rows = ['| Task | Before | After | Change |', '| --- | ---: | ---: | ---: |'];
  for (const a of after.cases) {
    const b = before.cases.find((x) => x.task === a.task);
    if (!b) continue;
    rows.push(
      `| ${a.task} (eval cases) | ${b.tokens} | ${a.tokens} | ${change(b.tokens, a.tokens)} |`,
    );
    if (a.score < b.score) lower.push(`${a.task}: score ${pct(b.score)} → ${pct(a.score)}`);
    if (a.thaiScore !== null && b.thaiScore !== null && a.thaiScore < b.thaiScore) {
      lower.push(`${a.task}: Thai score ${pct(b.thaiScore)} → ${pct(a.thaiScore)}`);
    }
  }
  const sa = after.scenarios;
  const sb = before.scenarios;
  if (sa && sb) {
    for (const a of sa.tasks) {
      const b = sb.tasks.find((x: TaskTokens) => x.task === a.task);
      if (!b) continue;
      rows.push(`| ${a.task} (product) | ${b.input} | ${a.input} | ${change(b.input, a.input)} |`);
    }
    for (const a of sa.replay) {
      const b = sb.replay.find((x) => x.prompt === a.prompt);
      if (b && a.score < b.score) {
        lower.push(`replay ${a.prompt}: ${pct(b.score)} → ${pct(a.score)}`);
      }
    }
    if (sb.foundNeedle && !sa.foundNeedle) lower.push('retrieval no longer finds the needle');
  }
  return { table: rows.join('\n'), lower };
}
