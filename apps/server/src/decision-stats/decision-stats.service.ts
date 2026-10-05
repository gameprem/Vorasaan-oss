import { BadRequestException, Injectable } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  DECISION_STATS_DEFAULT_WEEKS,
  DECISION_STATS_MAX_DAYS,
  type DecisionRequestKind,
  type DecisionRequestStatus,
  type DecisionStatsQuery,
  type DecisionStatsView,
  type LeadTimeStats,
  type TeamRole,
} from '@vorasaan/shared';
import { projectAccess } from '../brief/brief-access.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { responseWindowState } from '../decision-requests/decision-request.view.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ResponseWindowsService } from '../response-windows/response-windows.service.ts';
import { MINUTE, type WorkingCalendar } from '../response-windows/working-time.ts';
import {
  leadTime,
  needsInfoPauses,
  percentile,
  type RequestTimeline,
  timeWaited,
} from './lead-time.ts';

const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const person = { select: { id: true, name: true } } as const;

type Timeline = RequestTimeline & {
  kind: DecisionRequestKind;
  role: TeamRole;
  decidedAt: Date | null;
};

type TimelineRow = {
  id: string;
  kind: DecisionRequestKind;
  role: TeamRole;
  status: DecisionRequestStatus;
  submittedAt: Date;
  closedAt: Date | null;
  decidedAt: Date | null;
  recipients: string[];
  messages: { kind: 'QUESTION' | 'ANSWER' | 'NOTE'; at: number }[];
  delegatesAdded: { people: { id: string }[]; at: number }[];
  deciderChanges: { userId: string; at: number }[];
};

const round = (minutes: number | null) => (minutes === null ? null : Math.round(minutes));

function leadTimeStats(minutes: number[]): LeadTimeStats {
  return {
    decided: minutes.length,
    medianMinutes: round(percentile(minutes, 0.5)),
    p90Minutes: round(percentile(minutes, 0.9)),
  };
}

/**
 * Decision Lead Time for a Project (ADR 0011, ticket 0056), rebuilt from each request's
 * rows: sent (`submittedAt`), its Recipients (Delegates added at escalation step 2 from
 * that step's history entry), its Decider changes (Claims and reassigns), its NEEDS_INFO
 * spells (the QUESTION and ANSWER messages), and when it was decided (the Decision) or
 * withdrawn (`closedAt`). Counted in the Organization's Working Time.
 */
@Injectable()
export class DecisionStatsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly windows: ResponseWindowsService,
  ) {}

  async forProject(
    user: User,
    projectId: string,
    query: DecisionStatsQuery,
  ): Promise<DecisionStatsView> {
    const { organizationId } = await projectAccess(this.db, user, projectId);
    const now = this.clock.now();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DECISION_STATS_DEFAULT_WEEKS * WEEK);
    // The query schema checks a range given in full; this also covers one side left out.
    if (from >= to || to.getTime() - from.getTime() > DECISION_STATS_MAX_DAYS * DAY) {
      throw new BadRequestException(
        `The range must start before it ends and cover at most ${DECISION_STATS_MAX_DAYS} days`,
      );
    }
    const calendar = await this.windows.calendar(this.db, organizationId);

    const timelines = await this.timelines(projectId, from, to);
    const decided = timelines.flatMap((t) => {
      if (!t.decidedAt || t.decidedAt < from || t.decidedAt >= to) return [];
      const ms = leadTime(t, calendar);
      return ms === null ? [] : [{ kind: t.kind, at: t.decidedAt, minutes: ms / MINUTE }];
    });
    const minutesOf = (list: typeof decided) => list.map((d) => d.minutes);

    return {
      projectId,
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: calendar.timeZone,
      leadTime: {
        all: leadTimeStats(minutesOf(decided)),
        byKind: {
          BLOCKER: leadTimeStats(minutesOf(decided.filter((d) => d.kind === 'BLOCKER'))),
          QUESTION: leadTimeStats(minutesOf(decided.filter((d) => d.kind === 'QUESTION'))),
        },
      },
      weekly: this.weekly(decided, from, to),
      overdue: await this.overdue(projectId, now),
      waited: await this.waited(timelines, { from, to }, now, calendar),
    };
  }

  /** Weeks ending at `to`, oldest first; the first one starts no earlier than `from`. */
  private weekly(decided: { at: Date; minutes: number }[], from: Date, to: Date) {
    const weeks: DecisionStatsView['weekly'] = [];
    for (let end = to.getTime(); end > from.getTime(); end -= WEEK) {
      const start = Math.max(end - WEEK, from.getTime());
      const inWeek = decided.filter((d) => d.at.getTime() >= start && d.at.getTime() < end);
      weeks.unshift({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        decided: inWeek.length,
        medianMinutes: round(
          percentile(
            inWeek.map((d) => d.minutes),
            0.5,
          ),
        ),
      });
    }
    return weeks;
  }

  /**
   * The Project's requests sent before `to` and not closed before `from`, each with the
   * rows its timeline is rebuilt from, in one statement (ticket 0074). Times inside the
   * aggregates come back as epoch milliseconds.
   */
  private async timelines(projectId: string, from: Date, to: Date): Promise<Timeline[]> {
    const fromAt = from.toISOString();
    const toAt = to.toISOString();
    const rows = await this.db.$queryRaw<TimelineRow[]>`
      SELECT d.id, d.kind::text AS kind, d."deciderRole"::text AS role, d.status::text AS status,
             d."submittedAt", d."closedAt", dn."createdAt" AS "decidedAt",
             ARRAY(SELECT r."userId" FROM "RequestRecipient" r WHERE r."requestId" = d.id)
               AS recipients,
             (SELECT coalesce(json_agg(json_build_object(
                       'kind', m.kind, 'at', floor(extract(epoch FROM m."createdAt") * 1000))), '[]')
              FROM "RequestMessage" m WHERE m."requestId" = d.id) AS messages,
             (SELECT coalesce(json_agg(json_build_object(
                       'people', h.people, 'at', floor(extract(epoch FROM h."createdAt") * 1000))), '[]')
              FROM "RequestHistoryEntry" h
              WHERE h."requestId" = d.id AND h.kind = 'DELEGATES_ADDED') AS "delegatesAdded",
             (SELECT coalesce(json_agg(json_build_object(
                       'userId', c."deciderId", 'at', floor(extract(epoch FROM c."createdAt") * 1000))
                       ORDER BY c."createdAt"), '[]')
              FROM "DeciderChange" c WHERE c."requestId" = d.id) AS "deciderChanges"
      FROM "DecisionRequest" d
      JOIN "Feature" f ON f.id = d."featureId"
      JOIN "Team" t ON t.id = f."teamId"
      LEFT JOIN "Decision" dn ON dn."requestId" = d.id
      WHERE t."projectId" = ${projectId}
        AND d."submittedAt" < (${toAt}::timestamptz AT TIME ZONE 'UTC')
        AND (d.status IN ('OPEN', 'NEEDS_INFO')
          OR (d.status = 'WITHDRAWN' AND d."closedAt" >= (${fromAt}::timestamptz AT TIME ZONE 'UTC'))
          OR dn."createdAt" >= (${fromAt}::timestamptz AT TIME ZONE 'UTC'))`;
    return rows.map((r): Timeline => {
      const sentAt = r.submittedAt;
      // A Delegate added by escalation holds the request from that step on.
      const addedAt = new Map<string, Date>();
      for (const h of r.delegatesAdded) {
        for (const p of h.people) addedAt.set(p.id, new Date(h.at));
      }
      const decidedAt = r.decidedAt;
      return {
        id: r.id,
        kind: r.kind,
        role: r.role,
        sentAt,
        decidedAt,
        decided: decidedAt !== null,
        endedAt: decidedAt ?? (r.status === 'WITHDRAWN' ? (r.closedAt ?? sentAt) : null),
        pauses: needsInfoPauses(
          r.messages.map((m) => ({ kind: m.kind, createdAt: new Date(m.at) })),
        ),
        recipients: r.recipients.map((userId) => ({ userId, from: addedAt.get(userId) ?? sentAt })),
        deciderChanges: r.deciderChanges.map((c) => ({ userId: c.userId, at: new Date(c.at) })),
      };
    });
  }

  private async overdue(projectId: string, now: Date): Promise<DecisionStatsView['overdue']> {
    const rows = await this.db.decisionRequest.findMany({
      where: { feature: { team: { projectId } }, status: 'OPEN', dueAt: { lte: now } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        kind: true,
        featureId: true,
        deciderRole: true,
        dueAt: true,
        pausedAt: true,
        escalationStep: true,
        feature: { select: { title: true } },
        decider: person,
        recipients: { select: { user: person }, orderBy: { user: { name: 'asc' } } },
      },
    });
    return {
      count: rows.length,
      requests: rows.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        featureId: r.featureId,
        featureTitle: r.feature.title,
        deciderRole: r.deciderRole,
        waitingOn: r.decider ? [r.decider] : r.recipients.map((x) => x.user),
        responseWindow: responseWindowState(r),
      })),
    };
  }

  private async waited(
    timelines: Timeline[],
    range: { from: Date; to: Date },
    now: Date,
    calendar: WorkingCalendar,
  ): Promise<DecisionStatsView['waited']> {
    const { byPerson, byRole } = timeWaited(timelines, range, now, calendar);
    const people = await this.db.user.findMany({
      where: { id: { in: [...byPerson.keys()] } },
      select: { id: true, name: true },
    });
    const names = new Map(people.map((p) => [p.id, p.name]));
    const longestFirst = <T extends { minutes: number }>(a: T, b: T) => b.minutes - a.minutes;
    return {
      byPerson: [...byPerson]
        .map(([id, w]) => ({
          person: { id, name: names.get(id) ?? 'Someone' },
          minutes: Math.round(w.minutes),
          requests: w.requests,
        }))
        .sort((a, b) => longestFirst(a, b) || a.person.name.localeCompare(b.person.name)),
      byRole: [...byRole]
        .map(([role, w]) => ({
          role: role as TeamRole,
          minutes: Math.round(w.minutes),
          requests: w.requests,
        }))
        .sort((a, b) => longestFirst(a, b) || a.role.localeCompare(b.role)),
    };
  }
}
