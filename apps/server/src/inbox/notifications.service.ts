import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NotificationType, Prisma, PrismaClient } from '@vorasaan/db';
import type {
  ListNotificationsQuery,
  NotificationList,
  NotificationView,
  ReadAllNotificationsResult,
} from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { type ChatCardSignal, ChatCardSignals } from './chat-card-signals.ts';
import { EventBus } from './event-bus.ts';

/** The client a `$transaction` callback receives. */
export type Tx = Prisma.TransactionClient;

type MaybeId = string | null | undefined;

/**
 * What one change did to people's attention, collected inside its transaction and
 * pushed over `GET /events` only once that transaction has committed.
 */
export class Outbox {
  readonly inbox = new Set<string>();
  readonly notificationIds: string[] = [];
  readonly chatCards: ChatCardSignal[] = [];

  /** These people's Inbox Items may have changed. */
  inboxChanged(...userIds: (MaybeId | readonly MaybeId[])[]): this {
    for (const id of userIds.flat()) if (id) this.inbox.add(id);
    return this;
  }

  /** Cards for these people's chat apps (ticket 0058), sent only once committed. */
  chatCard(signal: ChatCardSignal): this {
    const to = [...new Set(signal.to.filter(Boolean))];
    if (to.length) this.chatCards.push({ ...signal, to });
    return this;
  }
}

const person = { select: { id: true, name: true } } as const;
const notificationInclude = {
  feature: { select: { id: true, title: true } },
  request: { select: { id: true, title: true, kind: true, status: true } },
  specVersion: { select: { id: true, version: true, approvedBy: person } },
  delegation: {
    select: { id: true, teamId: true, role: true, startsAt: true, endsAt: true, delegator: person },
  },
} satisfies Prisma.NotificationInclude;
type NotificationWithRelations = Prisma.NotificationGetPayload<{
  include: typeof notificationInclude;
}>;

/**
 * Writes Notifications inside the caller's transaction (never to the person who acted),
 * and serves each person their own.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly bus: EventBus,
    private readonly chatSignals: ChatCardSignals,
  ) {}

  outbox(): Outbox {
    return new Outbox();
  }

  /** Notifies `to`, minus the actor and duplicates, as part of `tx`. */
  async notify(
    tx: Tx,
    outbox: Outbox,
    notification: {
      type: NotificationType;
      to: readonly MaybeId[];
      /** Who acted, never notified; null when the system acted (escalation). */
      actorId: string | null;
      featureId?: string;
      requestId?: string;
      specVersionId?: string;
      delegationId?: string;
    },
  ): Promise<void> {
    const { to, actorId, ...fields } = notification;
    const userIds = [...new Set(to.filter((id): id is string => !!id && id !== actorId))];
    if (!userIds.length) return;
    const rows = await tx.notification.createManyAndReturn({
      data: userIds.map((userId) => ({ userId, ...fields })),
      select: { id: true },
    });
    outbox.notificationIds.push(...rows.map((r) => r.id));
  }

  /** SPEC_VERSION_CREATED to the Feature's PO Role Owners, except whoever approved it. */
  async specVersionCreated(
    tx: Tx,
    outbox: Outbox,
    version: { id: string; featureId: string; approvedById: string },
  ): Promise<void> {
    const owners = await tx.roleOwner.findMany({
      where: { featureId: version.featureId, role: 'PO' },
      select: { userId: true },
    });
    await this.notify(tx, outbox, {
      type: 'SPEC_VERSION_CREATED',
      to: owners.map((o) => o.userId),
      actorId: version.approvedById,
      featureId: version.featureId,
      specVersionId: version.id,
    });
  }

  /** Pushes the Outbox to connected clients. Call only after the transaction commits. */
  async publish(outbox: Outbox): Promise<void> {
    // Queued, never awaited: a slow or failing chat app never holds up the change.
    this.chatSignals.dispatch(outbox.chatCards);
    try {
      for (const userId of outbox.inbox) {
        this.bus.emit(userId, { event: 'inbox.changed', data: {} });
      }
      if (!outbox.notificationIds.length) return;
      const rows = await this.db.notification.findMany({
        where: { id: { in: outbox.notificationIds } },
        orderBy: { createdAt: 'asc' },
        include: notificationInclude,
      });
      for (const row of rows) {
        this.bus.emit(row.userId, {
          event: 'notification.created',
          data: { notification: toNotificationView(row) },
        });
      }
    } catch (error) {
      // The change itself has committed; a failed push only delays clients until they refetch.
      this.logger.error('Could not push events', error as Error);
    }
  }

  /**
   * Writes DELEGATION_STARTED for the user's Delegations that have started since they
   * were created in the future. Called on reads of the Inbox and Notifications and on
   * every `GET /events` heartbeat; the unique `delegationId` keeps it to one each.
   */
  async startDelegations(userId: string): Promise<void> {
    const now = new Date();
    const due = await this.db.delegation.findMany({
      where: {
        delegateId: userId,
        createdById: { not: userId },
        startsAt: { lte: now },
        endsAt: { gt: now },
        started: { is: null },
      },
      select: { id: true },
    });
    if (!due.length) return;
    const outbox = this.outbox();
    const rows = await this.db.notification.createManyAndReturn({
      data: due.map((d) => ({ userId, type: 'DELEGATION_STARTED' as const, delegationId: d.id })),
      skipDuplicates: true,
      select: { id: true },
    });
    outbox.notificationIds.push(...rows.map((r) => r.id));
    await this.publish(outbox);
  }

  async list(userId: string, query: ListNotificationsQuery): Promise<NotificationList> {
    await this.startDelegations(userId);
    const [rows, unreadCount] = await Promise.all([
      this.db.notification.findMany({
        where: { userId, ...(query.unread === 'true' && { readAt: null }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        include: notificationInclude,
      }),
      this.db.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { notifications: rows.map(toNotificationView), unreadCount };
  }

  /** Idempotent: an already-read Notification keeps its first `readAt`. */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    await this.db.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.db.notification.findFirst({
      where: { id, userId },
      include: notificationInclude,
    });
    if (!row) throw new NotFoundException('Notification not found');
    return toNotificationView(row);
  }

  async markAllRead(userId: string): Promise<ReadAllNotificationsResult> {
    const { count } = await this.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}

function toNotificationView(n: NotificationWithRelations): NotificationView {
  return {
    id: n.id,
    type: n.type,
    feature: n.feature,
    decisionRequest: n.request,
    specVersion: n.specVersion,
    delegation: n.delegation && {
      ...n.delegation,
      startsAt: n.delegation.startsAt.toISOString(),
      endsAt: n.delegation.endsAt.toISOString(),
    },
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}
