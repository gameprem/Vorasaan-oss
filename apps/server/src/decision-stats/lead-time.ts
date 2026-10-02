import {
  MINUTE,
  type WorkingCalendar,
  workingTimeBetween,
} from '../response-windows/working-time.ts';

// Decision Lead Time (ADR 0011, ticket 0056), as pure functions over a request's timeline:
// how long it took from sent to decided and whom it waited on meanwhile. Counted in the
// Organization's Working Time, like Response Windows, and without NEEDS_INFO: while the
// request waits for the Raiser's answer, it waits on nobody who decides.

/** What a Decision Request went through, rebuilt from its rows (see DecisionStatsService). */
export type RequestTimeline = {
  id: string;
  sentAt: Date;
  /** When it was decided or withdrawn; null while still open. */
  endedAt: Date | null;
  decided: boolean;
  /** Its NEEDS_INFO spells: from the Decider's QUESTION to the Raiser's ANSWER (null: still waiting). */
  pauses: { from: Date; to: Date | null }[];
  /** Who it was routed to, from when: everyone at `sentAt`, a Delegate from escalation step 2. */
  recipients: { userId: string; from: Date }[];
  /** Each new Decider after sending (Claim or reassign), in order. */
  deciderChanges: { userId: string; at: Date }[];
};

/** A stretch of time the request waited on `holders`, outside NEEDS_INFO. */
export type HeldSpan = { from: Date; to: Date; holders: string[] };

/** The NEEDS_INFO spells of a thread: a QUESTION pauses, the next ANSWER resumes. Notes don't count. */
export function needsInfoPauses(
  messages: { kind: 'QUESTION' | 'ANSWER' | 'NOTE'; createdAt: Date }[],
): RequestTimeline['pauses'] {
  const pauses: RequestTimeline['pauses'] = [];
  let open: Date | null = null;
  for (const m of [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (m.kind === 'QUESTION' && !open) open = m.createdAt;
    else if (m.kind === 'ANSWER' && open) {
      pauses.push({ from: open, to: m.createdAt });
      open = null;
    }
  }
  if (open) pauses.push({ from: open, to: null });
  return pauses;
}

/** Who held the request at `t`: its latest Decider change, or else its Recipients by then. */
function holdersAt(t: RequestTimeline, at: number): string[] {
  let decider: string | null = null;
  for (const c of t.deciderChanges) if (c.at.getTime() <= at) decider = c.userId;
  if (decider) return [decider];
  return [...new Set(t.recipients.filter((r) => r.from.getTime() <= at).map((r) => r.userId))];
}

/**
 * The spans the request waited on someone, from sent until decided, withdrawn or `now`:
 * NEEDS_INFO cut out, split wherever who held it changed.
 */
export function heldSpans(t: RequestTimeline, now: Date): HeldSpan[] {
  const start = t.sentAt.getTime();
  const end = (t.endedAt ?? now).getTime();
  if (end <= start) return [];
  const cuts = new Set<number>([start, end]);
  for (const r of t.recipients) cuts.add(r.from.getTime());
  for (const c of t.deciderChanges) cuts.add(c.at.getTime());
  for (const p of t.pauses) {
    cuts.add(p.from.getTime());
    if (p.to) cuts.add(p.to.getTime());
  }
  const points = [...cuts].filter((x) => x >= start && x <= end).sort((a, b) => a - b);
  const paused = (at: number) =>
    t.pauses.some((p) => p.from.getTime() <= at && (p.to === null || at < p.to.getTime()));

  const spans: HeldSpan[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] as number;
    const to = points[i + 1] as number;
    if (paused(from)) continue;
    const holders = holdersAt(t, from);
    const last = spans.at(-1);
    if (last && last.to.getTime() === from && same(last.holders, holders)) {
      last.to = new Date(to);
    } else {
      spans.push({ from: new Date(from), to: new Date(to), holders });
    }
  }
  return spans;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Working time between two instants, clipped to [lo, hi). */
function workingWithin(from: Date, to: Date, lo: Date, hi: Date, cal: WorkingCalendar): number {
  const a = Math.max(from.getTime(), lo.getTime());
  const b = Math.min(to.getTime(), hi.getTime());
  return b > a ? workingTimeBetween(new Date(a), new Date(b), cal) : 0;
}

/** Decision Lead Time in working milliseconds, or null while not decided. */
export function leadTime(t: RequestTimeline, cal: WorkingCalendar): number | null {
  if (!t.decided || !t.endedAt) return null;
  let total = 0;
  for (const s of heldSpans(t, t.endedAt)) total += workingTimeBetween(s.from, s.to, cal);
  return total;
}

export type Waited = { minutes: number; requests: number };

/**
 * The working time each person, and each request's decider Team Role (once per request),
 * kept requests waiting within [from, to), counting open requests up to `now`.
 */
export function timeWaited<R extends RequestTimeline & { role: string }>(
  timelines: R[],
  range: { from: Date; to: Date },
  now: Date,
  cal: WorkingCalendar,
): { byPerson: Map<string, Waited>; byRole: Map<string, Waited> } {
  const byPerson = new Map<string, Waited>();
  const byRole = new Map<string, Waited>();
  const hi = new Date(Math.min(range.to.getTime(), now.getTime()));
  const add = (map: Map<string, Waited>, key: string, ms: number, seen: Set<string>) => {
    const entry = map.get(key) ?? { minutes: 0, requests: 0 };
    entry.minutes += ms / MINUTE;
    if (!seen.has(key)) {
      entry.requests++;
      seen.add(key);
    }
    map.set(key, entry);
  };
  for (const t of timelines) {
    const people = new Set<string>();
    const roles = new Set<string>();
    for (const span of heldSpans(t, now)) {
      const ms = workingWithin(span.from, span.to, range.from, hi, cal);
      if (ms <= 0) continue;
      for (const holder of span.holders) add(byPerson, holder, ms, people);
      add(byRole, t.role, ms, roles);
    }
  }
  return { byPerson, byRole };
}

/** The p-th percentile (0..1) of `values`, interpolating between the closest ranks; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}
