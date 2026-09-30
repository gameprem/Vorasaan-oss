import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import {
  BriefVersionSource,
  DecisionRequestKind,
  DecisionRequestStatus,
  GrillingRoundKind,
  NotificationType,
  SpecVersionSource,
  TeamRole,
} from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

// ─── Inbox Items ────────────────────────────────────────────────────────────
// Derived from Decision Request, Proposal and Grilling state on every read; never stored.

export const FeatureRef = z.object({ id: Id, title: z.string() });
export type FeatureRef = z.infer<typeof FeatureRef>;

/** The Decision Request an Inbox Item or Notification is about. */
export const DecisionRequestRef = z.object({
  id: Id,
  title: z.string(),
  kind: DecisionRequestKind,
});
export type DecisionRequestRef = z.infer<typeof DecisionRequestRef>;

export const ProjectRef = z.object({ id: Id, name: z.string() });
export type ProjectRef = z.infer<typeof ProjectRef>;

/** When the underlying state last changed; the Inbox lists the newest first. */
const since = Timestamp;

/** Most Inbox Items are about a Feature; Project-level ones (Grilling, Brief) carry `project` instead. */
const itemBase = { feature: FeatureRef, since };
const projectItemBase = { project: ProjectRef, since };

const RequestToDecide = DecisionRequestRef.extend({
  raiser: PersonRef,
  deciderRole: TeamRole,
  /** Set when the viewer received the request as someone's Delegate. */
  onBehalfOf: PersonRef.nullable(),
});

export const InboxItem = z.discriminatedUnion('kind', [
  /** Decide an OPEN Decision Request where I'm the Decider. */
  z.object({ kind: z.literal('DECIDE'), ...itemBase, decisionRequest: RequestToDecide }),
  /** Claim or decide an OPEN Decision Request with no Decider where I'm a recipient. */
  z.object({ kind: z.literal('CLAIM'), ...itemBase, decisionRequest: RequestToDecide }),
  /** Answer the Decider's question on a NEEDS_INFO Decision Request I raised. */
  z.object({
    kind: z.literal('ANSWER'),
    ...itemBase,
    decisionRequest: DecisionRequestRef.extend({ decider: PersonRef.nullable() }),
    /** The Decider's latest question. */
    question: z.string().nullable(),
  }),
  /** Approve (or reject) a PENDING Spec Proposal where I'm the approver. */
  z.object({
    kind: z.literal('APPROVE_PROPOSAL'),
    ...itemBase,
    specProposal: z.object({
      id: Id,
      source: SpecVersionSource,
      /** The Decision Request whose Decision produced it, if any. */
      decisionRequest: DecisionRequestRef.nullable(),
    }),
  }),
  /** Answer the questions of a Grilling round asked to a Team Role I hold in the Project. */
  z.object({
    kind: z.literal('ANSWER_GRILLING'),
    ...projectItemBase,
    grilling: z.object({
      id: Id,
      round: GrillingRoundKind,
      role: TeamRole,
      /** Questions of the round nobody has answered yet. */
      unanswered: z.int().positive(),
    }),
  }),
  /** Approve (or reject) a PENDING Brief Proposal where I'm the approver. */
  z.object({
    kind: z.literal('APPROVE_BRIEF_PROPOSAL'),
    ...projectItemBase,
    briefProposal: z.object({ id: Id, source: BriefVersionSource }),
  }),
]);
export type InboxItem = z.infer<typeof InboxItem>;
export type InboxItemKind = InboxItem['kind'];

// ─── Notifications ──────────────────────────────────────────────────────────

export const NotificationView = z.object({
  id: Id,
  type: NotificationType,
  feature: FeatureRef.nullable(),
  /** REQUEST_DECIDED, REQUEST_CLAIMED, REQUEST_WITHDRAWN. */
  decisionRequest: DecisionRequestRef.extend({ status: DecisionRequestStatus }).nullable(),
  /** SPEC_VERSION_CREATED. */
  specVersion: z.object({ id: Id, version: z.int().positive(), approvedBy: PersonRef }).nullable(),
  /** DELEGATION_STARTED. */
  delegation: z
    .object({
      id: Id,
      teamId: Id,
      role: TeamRole,
      delegator: PersonRef,
      startsAt: Timestamp,
      endsAt: Timestamp,
    })
    .nullable(),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type NotificationView = z.infer<typeof NotificationView>;

export const ListNotificationsQuery = z.object({
  /** `true` leaves out the ones already read. */
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationList = z.object({
  /** Newest first. */
  notifications: z.array(NotificationView),
  unreadCount: z.int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;

export const ReadAllNotificationsResult = z.object({ updated: z.int().nonnegative() });
export type ReadAllNotificationsResult = z.infer<typeof ReadAllNotificationsResult>;

// ─── Event stream (GET /events, Server-Sent Events) ─────────────────────────

/** The viewer's Inbox Items may have changed: refetch GET /inbox. */
export const InboxChangedEvent = z.object({});
export type InboxChangedEvent = z.infer<typeof InboxChangedEvent>;

export const NotificationCreatedEvent = z.object({ notification: NotificationView });
export type NotificationCreatedEvent = z.infer<typeof NotificationCreatedEvent>;

/** One SSE message: its `event:` name and its JSON `data:` payload. */
export const ServerEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('inbox.changed'), data: InboxChangedEvent }),
  z.object({ event: z.literal('notification.created'), data: NotificationCreatedEvent }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventName = ServerEvent['event'];
