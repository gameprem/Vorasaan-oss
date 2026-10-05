'use client';

import {
  AI_USAGE_MAX_DAYS,
  type AiUsageTask,
  type AiUsageTotals,
  type AiUsageView,
  type ApprovedModelSettingsView,
  MAX_PRICE_PER_MILLION,
  MODEL_SUGGESTION_DAYS,
  type ModelSuggestion,
  type ModelSuggestionsView,
  type ProposalKind,
} from '@vorasaan/shared';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState, useTransition } from 'react';
import {
  type ActionResult,
  chooseTaskModel,
  saveAiBudget,
  saveModelPrices,
} from '@/lib/ai-usage-actions';
import { TASK_LABEL } from './ai-task-labels';
import { AI_USAGE_PATH } from './notification-text';
import { SettingsLink, useSettingsNavigate } from './settings-dialog';
import { field } from './ui';
import { Button } from './ui/button';
import { DateRangePicker } from './ui/date-picker';
import { SegmentedControl } from './ui/segmented-control';

// Settings → AI usage (ticket 0075): what the AI costs, where, and what it buys, from the
// Receipts. Every chart has a text summary and a table view, and its bars are one Tab stop
// moved through with the arrow keys. Colours are the ADR 0008 tokens, light and dark.

const whole = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
const cents = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** "$12.40", "$0.0315"; "–" without a price. */
export function usd(amount: number | null): string {
  if (amount === null) return '–';
  return amount >= 1 ? dollars.format(amount) : cents.format(amount);
}
const tokens = (n: number) => compact.format(n);
const calls = (n: number) => `${whole.format(n)} call${n === 1 ? '' : 's'}`;
const percent = (share: number | null) => (share === null ? '–' : `${Math.round(share * 100)}%`);
const latency = (ms: number | null) =>
  ms === null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

const TASK_NAME: Record<AiUsageTask, string> = {
  ...(Object.fromEntries(
    Object.entries(TASK_LABEL).map(([task, { label }]) => [task, label]),
  ) as Record<Exclude<AiUsageTask, 'EVAL_RUN'>, string>),
  EVAL_RUN: 'Eval Runs',
};

const PROPOSAL_NAME: Record<ProposalKind, string> = {
  CHOICES: 'Choices',
  SPEC_PROPOSAL: 'Spec Proposals',
  BRIEF_PROPOSAL: 'Brief Proposals',
  FEATURE_SUGGESTION: 'Feature Suggestions',
  PROMPT_VERSION: 'Prompt Versions',
};

/** Tokens in and out, the two series of every chart. */
const SERIES = [
  { name: 'Tokens in', color: 'var(--spark-a)' },
  { name: 'Tokens out', color: 'var(--spark-b)' },
] as const;

export function AiUsageDashboard({
  view,
  models,
  suggestions,
}: {
  view: AiUsageView;
  models: ApprovedModelSettingsView[];
  suggestions: ModelSuggestionsView;
}) {
  const { totals, costPerDecision: perDecision } = view;
  return (
    <div className="mt-6 space-y-10">
      <RangeForm from={view.from} to={view.to} timeZone={view.timeZone} />

      <section aria-labelledby="usage-headlines">
        <h3 id="usage-headlines" className="sr-only">
          Headlines
        </h3>
        <dl
          className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3"
          data-testid="usage-headlines"
        >
          <Stat
            label="Estimated cost"
            value={usd(totals.costUsd)}
            hint={
              !view.anyPrices
                ? 'Set a price on an Approved Model to see a cost'
                : totals.unpricedCalls
                  ? `${whole.format(totals.unpricedCalls)} calls without a price not counted`
                  : undefined
            }
          />
          <Stat
            label="Tokens in / out"
            value={`${tokens(totals.inputTokens)} / ${tokens(totals.outputTokens)}`}
            hint={`${calls(totals.calls)}${totals.failedCalls ? `, ${whole.format(totals.failedCalls)} failed` : ''}`}
          />
          <Stat
            label="Cache hit ratio"
            value={percent(totals.cacheHitRatio)}
            hint="Cache reads over input tokens"
          />
          <Stat
            label="Latency p50 / p95"
            value={`${latency(totals.latencyP50Ms)} / ${latency(totals.latencyP95Ms)}`}
          />
          <Stat
            label="Cost per decision"
            value={
              perDecision.averageCostUsd !== null
                ? usd(perDecision.averageCostUsd)
                : perDecision.averageTokens !== null
                  ? `${tokens(perDecision.averageTokens)} tokens`
                  : '–'
            }
            hint={
              perDecision.decisions
                ? `${whole.format(perDecision.decisions)} decision${perDecision.decisions === 1 ? '' : 's'}: Choices, Redrafts and Spec Proposal`
                : 'No decision the AI helped with in this range'
            }
          />
          <Stat
            label="Budget this month"
            value={
              view.budget.monthlyUsd === null
                ? 'None'
                : `${percent(view.budget.share)} of ${usd(view.budget.monthlyUsd)}`
            }
            hint={`${usd(view.budget.spentUsd)} spent in ${view.budget.month}`}
            tone={(view.budget.share ?? 0) >= 1 ? 'alert' : undefined}
          />
        </dl>
      </section>

      <DailyChart key={`daily-${view.from}-${view.to}`} view={view} />
      <TaskChart key={`tasks-${view.from}-${view.to}`} view={view} />

      <UsageTable
        title="By Project"
        first="Project"
        rows={view.byProject.map((p) => ({
          key: p.projectId ?? 'none',
          name: p.projectId
            ? (p.projectName ?? 'A deleted Project')
            : 'Organization-wide (Prompt proposals, Eval Runs)',
          usage: p,
        }))}
      />
      <UsageTable
        title="By Approved Model"
        first="Model"
        rows={view.byModel.map((m) => ({
          key: m.approvedModelId ?? `env:${m.name}`,
          name: m.approvedModelId ? m.name : `${m.name} (set on the server)`,
          usage: m,
        }))}
      />
      <RedraftsTable view={view} />
      <CheaperModels view={suggestions} />

      <BudgetForm view={view} />
      <PricesForm models={models} />
    </div>
  );
}

// ─── Range ──────────────────────────────────────────────────────────────────

function RangeForm({ from, to, timeZone }: { from: string; to: string; timeZone: string }) {
  const navigate = useSettingsNavigate();
  const [range, setRange] = useState({ start: from, end: to });
  const [pending, start] = useTransition();
  const valid =
    Boolean(range.start && range.end) &&
    range.start <= range.end &&
    (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 < AI_USAGE_MAX_DAYS;
  return (
    <form
      aria-label="Date range"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        start(() => navigate(`${AI_USAGE_PATH}?from=${range.start}&to=${range.end}`));
      }}
    >
      <DateRangePicker
        label="Range"
        description={`Days in ${timeZone}, both included; at most ${AI_USAGE_MAX_DAYS} days.`}
        value={range}
        onChange={setRange}
        className="w-80"
      />
      <Button type="submit" variant="secondary" isDisabled={!valid || pending}>
        Show
      </Button>
    </form>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'alert';
}) {
  return (
    <div>
      <dt className="text-sm text-fg-soft">{label}</dt>
      <dd
        className={`text-xl font-semibold tracking-tight ${tone === 'alert' ? 'text-lacquer' : ''}`}
      >
        {value}
      </dd>
      {hint && <dd className="text-xs text-fg-soft">{hint}</dd>}
    </div>
  );
}

// ─── Charts ─────────────────────────────────────────────────────────────────

type Bar = {
  key: string;
  /** Shown next to (or under) the bar; also starts its accessible name. */
  label: string;
  /** Tokens in and out. */
  values: [number, number];
  /** Everything about it, in one sentence: its accessible name and the readout. */
  detail: string;
};

/** A chart's frame: its title, the Chart/Table switch, its text summary, then either view. */
function ChartFrame({
  id,
  title,
  summary,
  chart,
  table,
}: {
  id: string;
  title: string;
  summary: string;
  chart: ReactNode;
  table: ReactNode;
}) {
  const [mode, setMode] = useState('chart');
  return (
    <section aria-labelledby={`${id}-title`} data-testid={id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h3>
        <SegmentedControl
          aria-label={`${title}: view`}
          segments={[
            { id: 'chart', label: 'Chart' },
            { id: 'table', label: 'Table' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>
      <p id={`${id}-summary`} className="mt-1 text-sm text-fg-soft">
        {summary}
      </p>
      <div className="mt-4">{mode === 'chart' ? chart : table}</div>
    </section>
  );
}

function Legend() {
  return (
    <ul className="mt-3 flex gap-4 text-xs text-fg-soft" aria-label="Legend">
      {SERIES.map((s) => (
        <li key={s.name} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: s.color }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * The bars of a chart as one Tab stop: the arrow keys (and Home and End) move between
 * them, each named by its `detail`, which the readout under the chart also shows.
 */
function useBars(bars: Bar[], initial: number) {
  const [active, setActive] = useState(Math.max(0, Math.min(initial, bars.length - 1)));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (to: number) => {
    const next = Math.max(0, Math.min(to, bars.length - 1));
    setActive(next);
    refs.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    if (e.key in step) move(active + (step[e.key] ?? 0));
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(bars.length - 1);
    else return;
    e.preventDefault();
  };
  const props = (i: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      refs.current[i] = el;
    },
    type: 'button' as const,
    tabIndex: i === active ? 0 : -1,
    'aria-label': bars[i]?.detail,
    onFocus: () => setActive(i),
    onMouseEnter: () => setActive(i),
    onKeyDown,
  });
  return { active, props };
}

const barFocus =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** Columns, one per day, tokens in stacked under tokens out. */
function ColumnChart({ bars, label }: { bars: Bar[]; label: string }) {
  const max = Math.max(1, ...bars.map((b) => b.values[0] + b.values[1]));
  const busiest = bars.reduce(
    (best, b, i) =>
      b.values[0] + b.values[1] > (bars[best]?.values[0] ?? 0) + (bars[best]?.values[1] ?? 0)
        ? i
        : best,
    bars.length - 1,
  );
  const { active, props } = useBars(bars, busiest);
  const ticks = [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])];
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="w-12 shrink-0 text-right text-xs text-fg-soft">{tokens(max)}</span>
        <div
          role="toolbar"
          aria-orientation="horizontal"
          aria-label={label}
          className="flex h-40 flex-1 items-end gap-px border-b border-line"
        >
          {bars.map((b, i) => (
            <button
              key={b.key}
              {...props(i)}
              className={`flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-sm hover:bg-surface ${i === active ? 'bg-surface' : ''} ${barFocus}`}
            >
              {[1, 0].map((s) =>
                b.values[s as 0 | 1] > 0 ? (
                  <span
                    key={s}
                    aria-hidden
                    className="block w-full first:rounded-t-sm"
                    style={{
                      height: `${(b.values[s as 0 | 1] / max) * 100}%`,
                      background: SERIES[s as 0 | 1].color,
                      // A hairline of the page between the two, so they read apart.
                      boxShadow: s === 1 ? 'inset 0 -1px 0 var(--bg)' : undefined,
                    }}
                  />
                ) : null,
              )}
            </button>
          ))}
        </div>
      </div>
      <div aria-hidden className="ml-14 mt-1 flex justify-between text-xs text-fg-soft">
        {ticks.map((t) => (
          <span key={bars[t]?.key ?? t}>{bars[t]?.label}</span>
        ))}
      </div>
      <Legend />
      <p className="mt-2 text-sm" data-testid="chart-readout">
        {bars[active]?.detail}
      </p>
    </div>
  );
}

/** Rows, one per task, tokens in and out side by side on one bar. */
function RowChart({ bars, label }: { bars: Bar[]; label: string }) {
  const max = Math.max(1, ...bars.map((b) => b.values[0] + b.values[1]));
  const { active, props } = useBars(bars, 0);
  return (
    <div>
      <div role="toolbar" aria-orientation="vertical" aria-label={label} className="space-y-1">
        {bars.map((b, i) => (
          <button
            key={b.key}
            {...props(i)}
            className={`grid w-full grid-cols-[9rem_1fr_4rem] items-center gap-3 rounded-tile px-2 py-1 text-left text-sm hover:bg-surface ${i === active ? 'bg-surface' : ''} ${barFocus}`}
          >
            <span className="truncate">{b.label}</span>
            <span aria-hidden className="flex h-3 overflow-hidden rounded-sm">
              {[0, 1].map((s) => (
                <span
                  key={s}
                  className="block h-full"
                  style={{
                    width: `${(b.values[s as 0 | 1] / max) * 100}%`,
                    background: SERIES[s as 0 | 1].color,
                    boxShadow: s === 1 ? 'inset 1px 0 0 var(--bg)' : undefined,
                  }}
                />
              ))}
            </span>
            <span className="text-right text-fg-soft">{tokens(b.values[0] + b.values[1])}</span>
          </button>
        ))}
      </div>
      <Legend />
      <p className="mt-2 text-sm" data-testid="chart-readout">
        {bars[active]?.detail}
      </p>
    </div>
  );
}

function DailyChart({ view }: { view: AiUsageView }) {
  const bars: Bar[] = view.daily.map((d) => ({
    key: d.date,
    label: day(d.date),
    values: [d.inputTokens, d.outputTokens],
    detail: `${day(d.date)}: ${whole.format(d.inputTokens)} tokens in, ${whole.format(d.outputTokens)} out, ${calls(d.calls)}${d.costUsd !== null ? `, ${usd(d.costUsd)}` : ''}`,
  }));
  const busiest = view.daily.reduce<(typeof view.daily)[number] | null>(
    (best, d) =>
      d.inputTokens + d.outputTokens > (best ? best.inputTokens + best.outputTokens : 0) ? d : best,
    null,
  );
  const { totals } = view;
  const summary = busiest
    ? `Over ${view.daily.length} days the AI read ${whole.format(totals.inputTokens)} tokens and wrote ${whole.format(totals.outputTokens)} in ${calls(totals.calls)}${totals.costUsd !== null ? `, an estimated ${usd(totals.costUsd)}` : ''}. The busiest day was ${day(busiest.date)}, with ${whole.format(busiest.inputTokens + busiest.outputTokens)} tokens.`
    : `No AI calls between ${day(view.from)} and ${day(view.to)}.`;
  return (
    <ChartFrame
      id="usage-daily"
      title="Tokens per day"
      summary={summary}
      chart={<ColumnChart bars={bars} label="Tokens per day" />}
      table={
        <ScrollTable label="Tokens per day">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Tokens per day</caption>
            <thead className="text-fg-soft">
              <tr>
                <th className="py-2 pr-3 font-medium">Day</th>
                <Num head>Calls</Num>
                <Num head>Tokens in</Num>
                <Num head>Tokens out</Num>
                <Num head>Estimated cost</Num>
              </tr>
            </thead>
            <tbody>
              {view.daily.map((d) => (
                <tr key={d.date} className="border-t border-line">
                  <th scope="row" className="py-1.5 pr-3 font-normal whitespace-nowrap">
                    {day(d.date)}
                  </th>
                  <Num>{whole.format(d.calls)}</Num>
                  <Num>{whole.format(d.inputTokens)}</Num>
                  <Num>{whole.format(d.outputTokens)}</Num>
                  <Num>{usd(d.costUsd)}</Num>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      }
    />
  );
}

function TaskChart({ view }: { view: AiUsageView }) {
  const rows = view.byTask.map((t) => ({ key: t.task, name: TASK_NAME[t.task], usage: t }));
  const bars: Bar[] = rows.map(({ key, name, usage }) => ({
    key,
    label: name,
    values: [usage.inputTokens, usage.outputTokens],
    detail: `${name}: ${whole.format(usage.inputTokens)} tokens in, ${whole.format(usage.outputTokens)} out, ${calls(usage.calls)}, cache hit ${percent(usage.cacheHitRatio)}, p50 ${latency(usage.latencyP50Ms)}, p95 ${latency(usage.latencyP95Ms)}${usage.costUsd !== null ? `, ${usd(usage.costUsd)}` : ''}`,
  }));
  const total = view.totals.inputTokens + view.totals.outputTokens;
  const top = [...rows].sort(
    (a, b) =>
      b.usage.inputTokens + b.usage.outputTokens - (a.usage.inputTokens + a.usage.outputTokens),
  )[0];
  const summary = top
    ? `${top.name} used the most tokens: ${whole.format(top.usage.inputTokens + top.usage.outputTokens)}, ${percent(total ? (top.usage.inputTokens + top.usage.outputTokens) / total : null)} of all. ${rows.length} task${rows.length === 1 ? '' : 's'} called the AI.`
    : 'No AI calls in this range.';
  return (
    <ChartFrame
      id="usage-tasks"
      title="By task"
      summary={summary}
      chart={
        bars.length ? (
          <RowChart bars={bars} label="Tokens by task" />
        ) : (
          <p className="text-sm text-fg-soft">Nothing to show.</p>
        )
      }
      table={<UsageRows title="By task" first="Task" rows={rows} />}
    />
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

/** A table that may scroll sideways in a narrow window: a focusable region then. */
function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
    <section aria-label={label} tabIndex={0} className={`overflow-x-auto rounded-tile ${barFocus}`}>
      {children}
    </section>
  );
}

function Num({ children, head }: { children: ReactNode; head?: boolean }) {
  return head ? (
    <th className="py-2 pl-3 text-right font-medium whitespace-nowrap">{children}</th>
  ) : (
    <td className="py-1.5 pl-3 text-right tabular-nums whitespace-nowrap">{children}</td>
  );
}

type UsageRow = { key: string; name: string; usage: AiUsageTotals };

function UsageRows({ title, first, rows }: { title: string; first: string; rows: UsageRow[] }) {
  if (!rows.length) return <p className="text-sm text-fg-soft">No AI calls in this range.</p>;
  return (
    <ScrollTable label={title}>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{title}</caption>
        <thead className="text-fg-soft">
          <tr>
            <th className="py-2 pr-3 font-medium">{first}</th>
            <Num head>Calls</Num>
            <Num head>Tokens in</Num>
            <Num head>Tokens out</Num>
            <Num head>Cache hit</Num>
            <Num head>Estimated cost</Num>
            <Num head>p50</Num>
            <Num head>p95</Num>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, usage }) => (
            <tr key={key} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-3 font-normal">
                {name}
              </th>
              <Num>
                {whole.format(usage.calls)}
                {usage.failedCalls ? (
                  <span className="text-fg-soft"> ({whole.format(usage.failedCalls)} failed)</span>
                ) : null}
              </Num>
              <Num>{whole.format(usage.inputTokens)}</Num>
              <Num>{whole.format(usage.outputTokens)}</Num>
              <Num>{percent(usage.cacheHitRatio)}</Num>
              <Num>{usd(usage.costUsd)}</Num>
              <Num>{latency(usage.latencyP50Ms)}</Num>
              <Num>{latency(usage.latencyP95Ms)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function UsageTable({ title, first, rows }: { title: string; first: string; rows: UsageRow[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      <div className="mt-3">
        <UsageRows title={title} first={first} rows={rows} />
      </div>
    </section>
  );
}

function RedraftsTable({ view }: { view: AiUsageView }) {
  const rows = view.redraftsBeforeApproval;
  return (
    <section aria-labelledby="usage-redrafts">
      <h3 id="usage-redrafts" className="text-lg font-semibold">
        Redrafts before approval
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        How many times people asked for changes before approving the AI’s proposals.
      </p>
      {rows.length ? (
        <table className="mt-3 w-full text-left text-sm">
          <caption className="sr-only">Redrafts before approval</caption>
          <thead className="text-fg-soft">
            <tr>
              <th className="py-2 pr-3 font-medium">Proposal</th>
              <Num head>Approved</Num>
              <Num head>As first drafted</Num>
              <Num head>Redrafts on average</Num>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.proposalKind} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 font-normal">
                  {PROPOSAL_NAME[r.proposalKind]}
                </th>
                <Num>{whole.format(r.approvals)}</Num>
                <Num>{percent(r.firstDraftApprovals / r.approvals)}</Num>
                <Num>{r.averageRedrafts.toFixed(1)}</Num>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-sm text-fg-soft">Nothing approved in this range.</p>
      )}
    </section>
  );
}

// ─── Cheaper models (ticket 0076) ───────────────────────────────────────────

function CheaperModels({ view }: { view: ModelSuggestionsView }) {
  return (
    <section aria-labelledby="usage-cheaper">
      <h3 id="usage-cheaper" className="text-lg font-semibold">
        Cheaper models
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        An Approved Model priced lower than the one a task runs on, whose latest Eval Runs score at
        least as well on every prompt of the task (the active versions, same sources). Nothing
        changes until you choose it.
      </p>
      {view.suggestions.length ? (
        <ul className="mt-4 space-y-5">
          {view.suggestions.map((s) => (
            <SuggestionRow key={s.task} suggestion={s} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-fg-soft">
          No cheaper model scores as well on any task yet.
        </p>
      )}
      {view.unchecked.length > 0 && (
        <div className="mt-5">
          <h4 className="font-medium">Cheaper, not evaluated yet</h4>
          <ul className="mt-2 space-y-1.5 text-sm">
            {view.unchecked.map((u) => (
              <li key={`${u.task}-${u.suggested.approvedModelId}`}>
                {TASK_LABEL[u.task].label}: {u.suggested.name} instead of {u.current.name}. Run
                evals of{' '}
                {u.prompts.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <SettingsLink
                      href={`/settings/ai/prompts/${p}`}
                      className="underline underline-offset-2"
                    >
                      {p}
                    </SettingsLink>
                  </span>
                ))}{' '}
                on both models to see whether it holds.
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SuggestionRow({ suggestion: s }: { suggestion: ModelSuggestion }) {
  const { pending, run, status } = useAction();
  const task = TASK_LABEL[s.task].label;
  const saved = s.currentCostUsd - s.suggestedCostUsd;
  return (
    <li data-testid={`suggestion-${s.task}`}>
      <p className="font-medium">
        {task}: {s.suggested.name} instead of {s.current.name}
      </p>
      <p className="text-sm text-fg-soft">
        {s.calls
          ? `${calls(s.calls)} in the last ${MODEL_SUGGESTION_DAYS} days: ${usd(s.currentCostUsd)} on ${s.current.name}, about ${usd(s.suggestedCostUsd)} on ${s.suggested.name} (${usd(saved)} less).`
          : `No calls in the last ${MODEL_SUGGESTION_DAYS} days yet; ${s.suggested.name} is priced lower.`}
      </p>
      <table className="mt-2 w-full text-left text-sm">
        <caption className="sr-only">
          Eval scores of {task} on {s.current.name} and {s.suggested.name}
        </caption>
        <thead className="text-fg-soft">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Prompt</th>
            <Num head>{s.current.name}</Num>
            <Num head>{s.suggested.name}</Num>
          </tr>
        </thead>
        <tbody>
          {s.prompts.map((p) => (
            <tr key={p.prompt} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-3 font-normal">
                {p.prompt}
              </th>
              <Num>{percent(p.current.score)}</Num>
              <Num>{percent(p.suggested.score)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          isDisabled={pending}
          onPress={() =>
            run(
              () => chooseTaskModel(s.task, s.suggested.approvedModelId),
              `${task} now run on ${s.suggested.name}.`,
            )
          }
        >
          Use {s.suggested.name} for {task}
        </Button>
        {status}
      </div>
    </li>
  );
}

// ─── Budget and prices ──────────────────────────────────────────────────────

function useAction() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const run = (action: () => Promise<ActionResult>, done: string) =>
    start(async () => {
      const result = await action();
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: done });
    });
  const status = message && (
    <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-jade' : 'text-lacquer'}>
      {message.text}
    </p>
  );
  return { pending, run, status, clear: () => setMessage(undefined) };
}

function BudgetForm({ view }: { view: AiUsageView }) {
  const [amount, setAmount] = useState(view.budget.monthlyUsd?.toString() ?? '');
  const { pending, run, status, clear } = useAction();
  const inputId = useId();
  const hintId = useId();
  const value = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(value) && value > 0;
  const share = Math.min(1, view.budget.share ?? 0);
  return (
    <section aria-labelledby="usage-budget">
      <h3 id="usage-budget" className="text-lg font-semibold">
        Monthly budget
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        The Admins get a Notification when the estimated cost of a month passes 80% and 100% of it.
        Nothing is ever blocked.
      </p>
      {view.budget.monthlyUsd !== null && (
        <div className="mt-3 max-w-md">
          <p className="text-sm" data-testid="budget-spent">
            {usd(view.budget.spentUsd)} of {usd(view.budget.monthlyUsd)} spent in{' '}
            {view.budget.month} ({percent(view.budget.share)}).
          </p>
          <div aria-hidden className="mt-1 h-2 overflow-hidden rounded-full bg-surface">
            <div
              className={`h-full ${(view.budget.share ?? 0) >= 1 ? 'bg-lacquer' : (view.budget.share ?? 0) >= 0.8 ? 'bg-saffron' : 'bg-ink'}`}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) run(() => saveAiBudget({ monthlyUsd: value }), 'Budget saved.');
        }}
      >
        <div>
          <label htmlFor={inputId} className="text-sm">
            Budget per month (US$)
          </label>
          <input
            id={inputId}
            type="number"
            step="any"
            inputMode="decimal"
            aria-describedby={hintId}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              clear();
            }}
            className={`${field} w-40`}
          />
        </div>
        <Button type="submit" variant="secondary" isDisabled={pending || !valid}>
          Save budget
        </Button>
        {view.budget.monthlyUsd !== null && (
          <Button
            variant="ghost"
            isDisabled={pending}
            onPress={() => {
              setAmount('');
              run(() => saveAiBudget({ monthlyUsd: null }), 'Budget removed.');
            }}
          >
            Remove budget
          </Button>
        )}
        <p id={hintId} className="w-full text-sm text-fg-soft">
          Months follow the Organization’s time zone ({view.timeZone}). Eval Runs count too.
        </p>
      </form>
      <div className="mt-2">{status}</div>
    </section>
  );
}

function PricesForm({ models }: { models: ApprovedModelSettingsView[] }) {
  return (
    <section aria-labelledby="usage-prices">
      <h3 id="usage-prices" className="text-lg font-semibold">
        Prices
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        What a million tokens cost on each Approved Model, in US dollars, from your provider’s price
        list. Input tokens include those read from the cache. A model without a price shows tokens
        only. A new price applies to past calls too: costs are estimates.
      </p>
      {models.length ? (
        <ul className="mt-4 space-y-4">
          {models.map((m) => (
            <PriceRow key={m.id} model={m} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-fg-soft">No Approved Models yet: add them in AI models.</p>
      )}
    </section>
  );
}

function PriceRow({ model }: { model: ApprovedModelSettingsView }) {
  const [input, setInput] = useState(model.prices?.inputPerMillion.toString() ?? '');
  const [output, setOutput] = useState(model.prices?.outputPerMillion.toString() ?? '');
  const { pending, run, status, clear } = useAction();
  const inputId = useId();
  const outputId = useId();
  const parse = (v: string) => (v.trim() === '' ? null : Number(v));
  const a = parse(input);
  const b = parse(output);
  const ok = (n: number | null) =>
    n !== null && Number.isFinite(n) && n >= 0 && n <= MAX_PRICE_PER_MILLION;
  const valid = (a === null && b === null) || (ok(a) && ok(b));
  return (
    <li>
      <form
        aria-label={`Price of ${model.displayName}`}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const prices =
            a === null || b === null ? null : { inputPerMillion: a, outputPerMillion: b };
          run(
            () => saveModelPrices(model.id, prices),
            prices
              ? `Price of ${model.displayName} saved.`
              : `Price of ${model.displayName} removed.`,
          );
        }}
      >
        <p className="w-full font-medium sm:w-44">
          {model.displayName}
          <span className="block text-xs font-normal text-fg-soft">{model.modelId}</span>
        </p>
        <div>
          <label htmlFor={inputId} className="text-sm">
            Input, $ per million
          </label>
          <input
            id={inputId}
            type="number"
            min={0}
            max={MAX_PRICE_PER_MILLION}
            step="any"
            inputMode="decimal"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              clear();
            }}
            className={`${field} w-32`}
          />
        </div>
        <div>
          <label htmlFor={outputId} className="text-sm">
            Output, $ per million
          </label>
          <input
            id={outputId}
            type="number"
            min={0}
            max={MAX_PRICE_PER_MILLION}
            step="any"
            inputMode="decimal"
            value={output}
            onChange={(e) => {
              setOutput(e.target.value);
              clear();
            }}
            className={`${field} w-32`}
          />
        </div>
        <Button type="submit" variant="secondary" isDisabled={pending || !valid}>
          Save price
        </Button>
        {!valid && (
          <p className="w-full text-sm text-lacquer">Give both prices, or leave both empty.</p>
        )}
      </form>
      <div className="mt-1">{status}</div>
    </li>
  );
}
