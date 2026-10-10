import type { DecisionStatsView, LeadTimeWeek } from '@vorasaan/shared';
import Link from 'next/link';
import { KindBadge, ResponseWindowLabels } from './bits';
import { ROLE_LABEL } from './ui';

// Decision Lead Time on the Project page (ADR 0011, ticket 0056): the median lead time,
// what is overdue now, a weekly trend, and the overdue requests. Every length is Working
// Time, without the waits for the Raiser's answer in NEEDS_INFO.

/** "45m", "2h 30m", "26h": working time, so no days (a working day is not 24 hours). */
export function workingSpan(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest && h < 10 ? `${h}h ${rest}m` : `${h}h`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The weekly median lead time as a line; weeks with no Decision leave a gap. */
function Sparkline({ weeks }: { weeks: LeadTimeWeek[] }) {
  const W = 160;
  const H = 40;
  const PAD = 5;
  const values = weeks.map((w) => w.medianMinutes);
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const x = (i: number) => PAD + (weeks.length > 1 ? (i * (W - 2 * PAD)) / (weeks.length - 1) : 0);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);

  // One path segment per run of weeks that had Decisions.
  let d = '';
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    d += `${drawing ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    drawing = true;
  });
  const decided = weeks.filter((w) => w.medianMinutes !== null);
  const label = decided.length
    ? `Weekly median lead time over ${weeks.length} weeks: ${decided
        .map((w) => `${day(w.start)} ${workingSpan(w.medianMinutes ?? 0)}`)
        .join(', ')}`
    : `No Decisions in the last ${weeks.length} weeks`;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      className="h-10 w-40 overflow-visible"
      data-testid="lead-time-trend"
    >
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--line)" strokeWidth={1} />
      {d && (
        <path
          d={d}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {weeks.map((w, i) =>
        w.medianMinutes === null ? null : (
          <circle
            key={w.start}
            cx={x(i)}
            cy={y(w.medianMinutes)}
            r={i === weeks.length - 1 ? 4 : 2.5}
            fill="var(--ink)"
            stroke="var(--bg)"
            strokeWidth={2}
          >
            <title>
              {`Week of ${day(w.start)}: median ${workingSpan(w.medianMinutes)}, ${w.decided} decided`}
            </title>
          </circle>
        ),
      )}
    </svg>
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
    <div className="min-w-32">
      <dt className="text-sm text-fg-soft">{label}</dt>
      <dd
        className={`text-2xl font-semibold tracking-tight ${tone === 'alert' ? 'text-lacquer' : ''}`}
      >
        {value}
      </dd>
      {hint && <dd className="text-xs text-fg-soft">{hint}</dd>}
    </div>
  );
}

export function DecisionSpeedPanel({ stats }: { stats: DecisionStatsView }) {
  const { all, byKind } = stats.leadTime;
  const median = all.medianMinutes === null ? '–' : workingSpan(all.medianMinutes);
  const kinds = [
    byKind.BLOCKER.medianMinutes !== null &&
      `Blockers ${workingSpan(byKind.BLOCKER.medianMinutes)}`,
    byKind.QUESTION.medianMinutes !== null &&
      `Questions ${workingSpan(byKind.QUESTION.medianMinutes)}`,
  ].filter(Boolean);
  const topRole = stats.waited.byRole[0];
  const weeks = stats.weekly.length;

  return (
    <section
      aria-labelledby="decision-speed-heading"
      className="mt-6 rounded-card bg-rail p-5"
      data-testid="decision-speed"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="decision-speed-heading" className="font-semibold">
          Decision speed
        </h2>
        <p className="text-xs text-fg-soft">
          Last {weeks} week{weeks === 1 ? '' : 's'}, in working time ({stats.timeZone}), without
          waits for more info
        </p>
      </div>

      <dl className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-4">
        <Stat
          label="Median lead time"
          value={median}
          hint={
            all.decided
              ? `${all.decided} decided${kinds.length ? ` · ${kinds.join(' · ')}` : ''}`
              : 'Nothing decided yet'
          }
        />
        <Stat
          label="Overdue now"
          value={String(stats.overdue.count)}
          tone={stats.overdue.count ? 'alert' : undefined}
          hint={topRole ? `Waiting longest: ${ROLE_LABEL[topRole.role]}` : undefined}
        />
        <div>
          <dt className="text-sm text-fg-soft">Weekly median</dt>
          <dd className="mt-1">
            <Sparkline weeks={stats.weekly} />
          </dd>
        </div>
      </dl>

      {stats.overdue.requests.length > 0 && (
        <div className="mt-5">
          <h3 id="overdue-heading" className="text-sm font-semibold">
            Overdue requests
          </h3>
          <ul aria-labelledby="overdue-heading" className="mt-2 rows">
            {stats.overdue.requests.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={r.kind} />
                  <Link
                    href={`/requests/${r.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {r.title}
                  </Link>
                  <ResponseWindowLabels state={r.responseWindow} />
                </div>
                <p className="mt-1 text-sm text-fg-soft">
                  {r.featureTitle} · waiting on{' '}
                  {r.waitingOn.length ? r.waitingOn.map((p) => p.name).join(', ') : 'nobody'} (
                  {ROLE_LABEL[r.deciderRole]})
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
