import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  NotificationType,
  Prisma,
  PrismaClient,
  RequestHistoryKind,
  TeamRole,
} from '@vorasaan/db';
import { ESCALATION_STEPS } from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { delegatesOf, delegationsActiveAt } from '../delegations/active-delegations.ts';
import {
  type NotificationInput,
  NotificationsService,
  type Outbox,
  type Tx,
} from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ResponseWindowsService } from './response-windows.service.ts';
import { addWorkingTime, MINUTE, type WorkingCalendar } from './working-time.ts';

/**
 * When each escalation step is due: the reminder when the window runs out, the
 * Delegates half a window later, and the Raiser and Tech Leads half a window after that.
 */
export function escalationTimes(dueAt: Date, windowMs: number, cal: WorkingCalendar): Date[] {
  const half = Math.ceil(windowMs / 2 / MINUTE) * MINUTE;
  return [dueAt, addWorkingTime(dueAt, half, cal), addWorkingTime(dueAt, windowMs, cal)];
}

type StepKind = { history: RequestHistoryKind; notification: NotificationType };

const STEP_KIND: Record<number, StepKind> = {
  1: { history: 'REMINDED', notification: 'REQUEST_REMINDER' },
  2: { history: 'DELEGATES_ADDED', notification: 'REQUEST_ESCALATED' },
  3: { history: 'OVERDUE_REPORTED', notification: 'REQUEST_OVERDUE' },
};

export type EscalationRun = { checked: number; steps: { requestId: string; step: number }[] };

/**
 * How many due requests one transaction escalates (ticket 0074): their rows are locked
 * together and their reads and writes batched, instead of some 40 statements and a
 * commit per request.
 */
export const ESCALATION_BATCH_SIZE = 200;

type DueRequest = {
  id: string;
  featureId: string;
  raiserId: string;
  deciderId: string | null;
  deciderRole: TeamRole;
  dueAt: Date | null;
  responseWindowMinutes: number | null;
  escalationStep: number;
  teamId: string;
  organizationId: string;
  /** Who it was sent to (User ids), as read under the lock. */
  recipients: string[];
};

/** One escalation step of one request, before its people are known by name. */
type TakenStep = { request: DueRequest; step: number; to: string[] };

/**
 * Escalates OPEN Decision Requests whose Response Window has run out (ADR 0011).
 * Due requests are handled in batches, each in its own transaction under row locks
 * taken with SKIP LOCKED, and each request's step is re-read under its lock, so the job
 * is idempotent and safe with several server instances running it at once. A batch that
 * fails is retried one request at a time, so one bad request never holds back the
 * others. It only reminds, adds Recipients and notifies: it never changes the Decider or
 * the status, and a request that is decided, withdrawn or waiting in NEEDS_INFO is left
 * alone.
 */
@Injectable()
export class EscalationJob {
  private readonly logger = new Logger(EscalationJob.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly windows: ResponseWindowsService,
  ) {}

  async run(): Promise<EscalationRun> {
    const now = this.clock.now();
    const due = await this.db.decisionRequest.findMany({
      where: { status: 'OPEN', dueAt: { lte: now }, escalationStep: { lt: ESCALATION_STEPS } },
      select: { id: true },
      orderBy: { dueAt: 'asc' },
    });
    const run: EscalationRun = { checked: due.length, steps: [] };
    // Each Organization's calendar, read once per run.
    const calendars = new Map<string, WorkingCalendar>();
    for (let i = 0; i < due.length; i += ESCALATION_BATCH_SIZE) {
      const ids = due.slice(i, i + ESCALATION_BATCH_SIZE).map((d) => d.id);
      let taken: Map<string, number[]>;
      try {
        taken = await this.escalate(ids, now, calendars);
      } catch (error) {
        taken = new Map();
        if (ids.length === 1) {
          this.logger.error(`Could not escalate Decision Request ${ids[0]}`, error as Error);
        } else {
          // Find the one that fails; the others still escalate.
          for (const id of ids) {
            try {
              for (const [requestId, steps] of await this.escalate([id], now, calendars)) {
                taken.set(requestId, steps);
              }
            } catch (one) {
              this.logger.error(`Could not escalate Decision Request ${id}`, one as Error);
            }
          }
        }
      }
      for (const id of ids) {
        for (const step of taken.get(id) ?? []) run.steps.push({ requestId: id, step });
      }
    }
    return run;
  }

  /** Takes the steps now due for these requests, in one transaction; returns the ones taken. */
  private async escalate(
    ids: string[],
    now: Date,
    calendars: Map<string, WorkingCalendar>,
  ): Promise<Map<string, number[]>> {
    const outbox = this.notifications.outbox();
    const taken = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "DecisionRequest"
        WHERE id = ANY(${ids}::text[]) AND status = 'OPEN'
        ORDER BY id
        FOR UPDATE SKIP LOCKED`;
      // Others are held by another instance, or changed meanwhile.
      if (!locked.length) return new Map<string, number[]>();

      // Re-read under the locks, in one statement: what the steps depend on may have changed.
      const order = new Map(ids.map((id, i) => [id, i]));
      const requests = (
        await tx.$queryRaw<DueRequest[]>`
          SELECT d.id, d."featureId", d."raiserId", d."deciderId", d."deciderRole"::text AS "deciderRole",
                 d."dueAt", d."responseWindowMinutes", d."escalationStep",
                 f."teamId", p."organizationId",
                 ARRAY(SELECT r."userId" FROM "RequestRecipient" r WHERE r."requestId" = d.id)
                   AS recipients
          FROM "DecisionRequest" d
          JOIN "Feature" f ON f.id = d."featureId"
          JOIN "Team" t ON t.id = f."teamId"
          JOIN "Project" p ON p.id = t."projectId"
          WHERE d.id = ANY(${locked.map((l) => l.id)}::text[])`
      ).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

      // Which steps each request is due for now.
      const due: { request: DueRequest; steps: number[]; target: number }[] = [];
      for (const request of requests) {
        if (!request.dueAt || !request.responseWindowMinutes) continue;
        const { organizationId } = request;
        let calendar = calendars.get(organizationId);
        if (!calendar) {
          calendar = await this.windows.calendar(tx, organizationId);
          calendars.set(organizationId, calendar);
        }
        const times = escalationTimes(
          request.dueAt,
          request.responseWindowMinutes * MINUTE,
          calendar,
        );
        const target = times.filter((t) => t <= now).length;
        const steps: number[] = [];
        for (let step = request.escalationStep + 1; step <= target; step++) {
          if (STEP_KIND[step]) steps.push(step);
        }
        if (target > request.escalationStep) due.push({ request, steps, target });
      }
      if (!due.length) return new Map<string, number[]>();

      const stepsTaken = await this.takeSteps(tx, outbox, due, now);

      // Every request's new step in one statement (`updatedAt` as Prisma's @updatedAt sets it).
      await tx.$executeRaw`
        UPDATE "DecisionRequest" d
        SET "escalationStep" = u.step,
            "updatedAt" = ${new Date().toISOString()}::timestamptz AT TIME ZONE 'UTC'
        FROM unnest(${due.map((d) => d.request.id)}::text[], ${due.map((d) => d.target)}::int[])
          AS u(id, step)
        WHERE d.id = u.id`;
      return stepsTaken;
    });
    await this.notifications.publish(outbox);
    return taken;
  }

  /**
   * Every step due in the batch: Delegates added as Recipients (step 2), Notifications,
   * the history entries naming whom each step went to, and the events for after commit.
   */
  private async takeSteps(
    tx: Tx,
    outbox: Outbox,
    due: { request: DueRequest; steps: number[] }[],
    now: Date,
  ): Promise<Map<string, number[]>> {
    const steps = due.flatMap(({ request, steps }) => steps.map((step) => ({ request, step })));
    const teamsAt = (step: number) => [
      ...new Set(steps.filter((s) => s.step === step).map((s) => s.request.teamId)),
    ];

    // Step 2: the Delegates active now of everyone each request was sent to.
    const delegationTeams = teamsAt(2);
    const delegations = delegationTeams.length
      ? await delegationsActiveAt(tx, {
          teamIds: delegationTeams,
          delegatorIds: [
            ...new Set(steps.filter((s) => s.step === 2).flatMap((s) => s.request.recipients)),
          ],
          at: now,
        })
      : [];
    // Step 3: the Teams' Tech Leads.
    const techLeadTeams = teamsAt(3);
    const techLeads = techLeadTeams.length
      ? await tx.teamMembership.findMany({
          where: { teamId: { in: techLeadTeams }, role: 'TECH_LEAD' },
          select: { teamId: true, userId: true },
        })
      : [];

    const taken: TakenStep[] = [];
    const newRecipients: Prisma.RequestRecipientCreateManyInput[] = [];
    for (const { request, step } of steps) {
      const { recipients } = request;
      // Who the request waits on: its Decider, or everyone it was sent to while nobody has Claimed it.
      const waitingOn = request.deciderId ? [request.deciderId] : recipients;
      let to: string[];

      if (step === 1) {
        to = waitingOn;
      } else if (step === 2) {
        const delegates = delegatesOf(delegations, {
          teamId: request.teamId,
          role: request.deciderRole,
          delegatorIds: recipients,
        });
        const added = new Map<string, string>();
        for (const [delegatorId, delegateId] of delegates) {
          if (delegateId === request.raiserId || recipients.includes(delegateId)) continue;
          if (!added.has(delegateId)) added.set(delegateId, delegatorId);
        }
        for (const [userId, onBehalfOfId] of added) {
          newRecipients.push({ requestId: request.id, userId, onBehalfOfId });
        }
        to = [...added.keys()];
        // The labels of everyone it waits on change to "escalated".
        outbox.inboxChanged(waitingOn);
      } else {
        const leads = techLeads.filter((t) => t.teamId === request.teamId);
        to = [...new Set([request.raiserId, ...leads.map((t) => t.userId)])];
        outbox.inboxChanged(waitingOn);
      }

      outbox.inboxChanged(to);
      outbox.chatCard({ kind: 'ESCALATION', requestId: request.id, step, to });
      taken.push({ request, step, to });
    }

    if (newRecipients.length) {
      await tx.requestRecipient.createMany({ data: newRecipients, skipDuplicates: true });
    }
    await this.notifications.notifyAll(
      tx,
      outbox,
      taken.map(
        ({ request, step, to }): NotificationInput => ({
          type: (STEP_KIND[step] as StepKind).notification,
          to,
          actorId: null,
          featureId: request.featureId,
          requestId: request.id,
        }),
      ),
    );

    // The history names everyone each step went to, sorted by name.
    const everyone = [...new Set(taken.flatMap((t) => t.to))];
    const people = everyone.length
      ? await tx.user.findMany({
          where: { id: { in: everyone } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : [];
    const entries = taken.map(({ request, step, to }) => {
      const named = new Set(to);
      return {
        requestId: request.id,
        kind: (STEP_KIND[step] as StepKind).history,
        people: JSON.stringify(people.filter((p) => named.has(p.id))),
      };
    });
    await tx.$executeRaw`
      INSERT INTO "RequestHistoryEntry" ("id", "requestId", "kind", "people", "createdAt")
      SELECT h.id, h."requestId", h.kind::"RequestHistoryKind", h.people::jsonb,
             ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      FROM unnest(
        ${entries.map(() => randomUUID())}::text[], ${entries.map((e) => e.requestId)}::text[],
        ${entries.map((e) => e.kind)}::text[], ${entries.map((e) => e.people)}::text[]
      ) AS h(id, "requestId", kind, people)`;

    const result = new Map<string, number[]>();
    for (const { request, step } of taken) {
      result.set(request.id, [...(result.get(request.id) ?? []), step]);
    }
    return result;
  }
}
