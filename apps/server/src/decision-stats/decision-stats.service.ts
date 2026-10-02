import { BadRequestException, Injectable } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  DECISION_STATS_DEFAULT_WEEKS,
  DECISION_STATS_MAX_DAYS,
  type DecisionRequestKind,
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

  /** The Project's requests sent before `to` and not closed before `from`. */
  private async timelines(projectId: string, from: Date, to: Date): Promise<Timeline[]> {
    const rows = await this.db.decisionRequest.findMany({
      where: {
        feature: { team: { projectId } },
        submittedAt: { not: null, lt: to },
        OR: [
          { status: { in: ['OPEN', 'NEEDS_INFO'] } },
          { status: 'WITHDRAWN', closedAt: { gte: from } },
          { decision: { createdAt: { gte: from } } },
        ],
      },
      select: {
        id: true,
        kind: true,
        deciderRole: true,
        status: true,
        submittedAt: true,
        closedAt: true,
        recipients: { select: { userId: true } },
        decision: { select: { createdAt: true } },
        messages: { select: { kind: true, createdAt: true } },
        history: { where: { kind: 'DELEGATES_ADDED' }, select: { people: true, createdAt: true } },
        deciderChanges: {
          select: { deciderId: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return rows.flatMap((r): Timeline[] => {
      if (!r.submittedAt) return [];
      const sentAt = r.submittedAt;
      // A Delegate added by escalation holds the request from that step on.
      const addedAt = new Map<string, Date>();
      for (const h of r.history) {
        for (const p of h.people as { id: string }[]) addedAt.set(p.id, h.createdAt);
      }
      const decidedAt = r.decision?.createdAt ?? null;
      return [
        {
          id: r.id,
          kind: r.kind,
          role: r.deciderRole,
          sentAt,
          decidedAt,
          decided: decidedAt !== null,
          endedAt: decidedAt ?? (r.status === 'WITHDRAWN' ? (r.closedAt ?? sentAt) : null),
          pauses: needsInfoPauses(r.messages),
          recipients: r.recipients.map((x) => ({
            userId: x.userId,
            from: addedAt.get(x.userId) ?? sentAt,
          })),
          deciderChanges: r.deciderChanges.map((c) => ({ userId: c.deciderId, at: c.createdAt })),
        },
      ];
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
