import { z } from 'zod';
import { DecisionRequestKind, TeamRole } from './enums.ts';
import { ResponseWindowState } from './response-window.ts';

// Decision Lead Time (ADR 0011, ticket 0056): how long a Project's Decision Requests take
// from being sent to being decided, and where they wait. Every length is in working
// minutes of the Organization's Working Time, without the time spent in NEEDS_INFO
// waiting for the Raiser's answer.

const Id = z.uuid();
const Timestamp = z.iso.datetime();
const DAY = 24 * 60 * 60 * 1000;

/** The range a query covers when it leaves `from` out: the 12 weeks before `to`. */
export const DECISION_STATS_DEFAULT_WEEKS = 12;
/** The longest range one query may cover. */
export const DECISION_STATS_MAX_DAYS = 366;

/**
 * `GET /projects/:id/decision-stats?from&to`. `to` defaults to now and `from` to 12 weeks
 * before `to`; lead times count the requests decided in [from, to).
 */
export const DecisionStatsQuery = z
  .object({
    from: Timestamp.optional(),
    to: Timestamp.optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), {
    message: '`from` must be before `to`',
    path: ['from'],
  })
  .refine(
    (q) =>
      !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= DECISION_STATS_MAX_DAYS * DAY,
    { message: `The range can cover at most ${DECISION_STATS_MAX_DAYS} days`, path: ['from'] },
  );
export type DecisionStatsQuery = z.infer<typeof DecisionStatsQuery>;

/** The median and 90th percentile of the lead times of the requests decided in the range. */
export const LeadTimeStats = z.object({
  /** How many requests were decided in the range. */
  decided: z.int().nonnegative(),
  /** In working minutes; null when nothing was decided. */
  medianMinutes: z.number().nonnegative().nullable(),
  p90Minutes: z.number().nonnegative().nullable(),
});
export type LeadTimeStats = z.infer<typeof LeadTimeStats>;

/** One week of the trend, oldest first; the last week ends at `to`. */
export const LeadTimeWeek = z.object({
  start: Timestamp,
  end: Timestamp,
  decided: z.int().nonnegative(),
  medianMinutes: z.number().nonnegative().nullable(),
});
export type LeadTimeWeek = z.infer<typeof LeadTimeWeek>;

const Person = z.object({ id: Id, name: z.string() });

/** An OPEN request whose Response Window has run out. */
export const OverdueRequest = z.object({
  id: Id,
  title: z.string(),
  kind: DecisionRequestKind,
  featureId: Id,
  featureTitle: z.string(),
  deciderRole: TeamRole,
  /** Its Decider or, while nobody has Claimed it, its Recipients. */
  waitingOn: z.array(Person),
  responseWindow: ResponseWindowState,
});
export type OverdueRequest = z.infer<typeof OverdueRequest>;

export const DecisionStatsView = z.object({
  projectId: Id,
  from: Timestamp,
  to: Timestamp,
  /** The Organization's time zone, which Working Time is counted in. */
  timeZone: z.string(),
  leadTime: z.object({
    all: LeadTimeStats,
    byKind: z.object({ BLOCKER: LeadTimeStats, QUESTION: LeadTimeStats }),
  }),
  weekly: z.array(LeadTimeWeek),
  /** Overdue now, whatever the range: most overdue first. */
  overdue: z.object({ count: z.int().nonnegative(), requests: z.array(OverdueRequest) }),
  /**
   * Working time the Project's requests waited in the range (up to now), per person who
   * held them (the routed Recipients until Claimed, then the Decider) and per decider
   * Team Role. Longest first. A request held by several Recipients counts for each of
   * them, and once for its Team Role.
   */
  waited: z.object({
    byPerson: z.array(
      z.object({ person: Person, minutes: z.number().nonnegative(), requests: z.int() }),
    ),
    byRole: z.array(
      z.object({ role: TeamRole, minutes: z.number().nonnegative(), requests: z.int() }),
    ),
  }),
});
export type DecisionStatsView = z.infer<typeof DecisionStatsView>;
