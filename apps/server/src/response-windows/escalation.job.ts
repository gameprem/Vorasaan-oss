import { Injectable, Logger } from '@nestjs/common';
import type { NotificationType, PrismaClient, RequestHistoryKind, TeamRole } from '@vorasaan/db';
import { ESCALATION_STEPS } from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { activeDelegates } from '../delegations/active-delegations.ts';
import { NotificationsService, type Outbox, type Tx } from '../inbox/notifications.service.ts';
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

const STEP_KIND: Record<number, { history: RequestHistoryKind; notification: NotificationType }> = {
  1: { history: 'REMINDED', notification: 'REQUEST_REMINDER' },
  2: { history: 'DELEGATES_ADDED', notification: 'REQUEST_ESCALATED' },
  3: { history: 'OVERDUE_REPORTED', notification: 'REQUEST_OVERDUE' },
};

export type EscalationRun = { checked: number; steps: { requestId: string; step: number }[] };

/**
 * Escalates OPEN Decision Requests whose Response Window has run out (ADR 0011).
 * Each request is handled in its own transaction under a row lock taken with
 * SKIP LOCKED, and its step is re-read under that lock, so the job is idempotent and
 * safe with several server instances running it at once. It only reminds, adds
 * Recipients and notifies: it never changes the Decider or the status, and a request
 * that is decided, withdrawn or waiting in NEEDS_INFO is left alone.
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
    for (const { id } of due) {
      try {
        const steps = await this.escalate(id, now);
        for (const step of steps) run.steps.push({ requestId: id, step });
      } catch (error) {
        this.logger.error(`Could not escalate Decision Request ${id}`, error as Error);
      }
    }
    return run;
  }

  /** Takes the steps now due for one request; returns the ones taken. */
  private async escalate(id: string, now: Date): Promise<number[]> {
    const outbox = this.notifications.outbox();
    const taken = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "DecisionRequest"
        WHERE id = ${id} AND status = 'OPEN'
        FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return []; // another instance has it, or it changed meanwhile

      const request = await tx.decisionRequest.findUniqueOrThrow({
        where: { id },
        include: {
          feature: { select: { teamId: true, team: { select: { project: true } } } },
          recipients: { select: { userId: true } },
        },
      });
      if (!request.dueAt || !request.responseWindowMinutes) return [];
      const calendar = await this.windows.calendar(tx, request.feature.team.project.organizationId);
      const times = escalationTimes(
        request.dueAt,
        request.responseWindowMinutes * MINUTE,
        calendar,
      );
      const target = times.filter((t) => t <= now).length;
      const steps: number[] = [];
      for (let step = request.escalationStep + 1; step <= target; step++) {
        await this.takeStep(tx, outbox, request, step, now);
        steps.push(step);
      }
      if (steps.length) {
        await tx.decisionRequest.update({
          where: { id },
          data: { escalationStep: target },
        });
      }
      return steps;
    });
    await this.notifications.publish(outbox);
    return taken;
  }

  private async takeStep(
    tx: Tx,
    outbox: Outbox,
    request: {
      id: string;
      featureId: string;
      raiserId: string;
      deciderId: string | null;
      deciderRole: TeamRole;
      feature: { teamId: string };
      recipients: { userId: string }[];
    },
    step: number,
    now: Date,
  ) {
    const kind = STEP_KIND[step];
    if (!kind) return;
    const recipients = request.recipients.map((r) => r.userId);
    // Who the request waits on: its Decider, or everyone it was sent to while nobody has Claimed it.
    const waitingOn = request.deciderId ? [request.deciderId] : recipients;
    let to: string[];

    if (step === 1) {
      to = waitingOn;
    } else if (step === 2) {
      const delegates = await activeDelegates(tx, {
        teamId: request.feature.teamId,
        role: request.deciderRole,
        delegatorIds: recipients,
        at: now,
      });
      const added = new Map<string, string>();
      for (const [delegatorId, delegateId] of delegates) {
        if (delegateId === request.raiserId || recipients.includes(delegateId)) continue;
        if (!added.has(delegateId)) added.set(delegateId, delegatorId);
      }
      if (added.size) {
        await tx.requestRecipient.createMany({
          data: [...added].map(([userId, onBehalfOfId]) => ({
            requestId: request.id,
            userId,
            onBehalfOfId,
          })),
          skipDuplicates: true,
        });
      }
      to = [...added.keys()];
      // The labels of everyone it waits on change to "escalated".
      outbox.inboxChanged(waitingOn);
    } else {
      const techLeads = await tx.teamMembership.findMany({
        where: { teamId: request.feature.teamId, role: 'TECH_LEAD' },
        select: { userId: true },
      });
      to = [...new Set([request.raiserId, ...techLeads.map((t) => t.userId)])];
      outbox.inboxChanged(waitingOn);
    }

    outbox.inboxChanged(to);
    outbox.chatCard({ kind: 'ESCALATION', requestId: request.id, step, to });
    await this.notifications.notify(tx, outbox, {
      type: kind.notification,
      to,
      actorId: null,
      featureId: request.featureId,
      requestId: request.id,
    });
    const people = to.length
      ? await tx.user.findMany({
          where: { id: { in: to } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : [];
    await tx.requestHistoryEntry.create({
      data: { requestId: request.id, kind: kind.history, people, createdAt: now },
    });
  }
}
