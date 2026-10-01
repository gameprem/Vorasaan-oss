import { z } from 'zod';
import { ActionCardView } from './action-card.ts';
import { PersonRef } from './decision-request.ts';
import {
  ConversationMessageRole,
  GrillingRoundKind,
  GrillingRoundStatus,
  GrillingStatus,
  TeamRole,
} from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();
// The same shapes as inbox.ts's refs, which imports this file's events.
const ProjectRef = z.object({ id: Id, name: z.string() });
const FeatureRef = z.object({ id: Id, title: z.string() });

// ─── Conversations (ADR 0008, ticket 0042) ──────────────────────────────────
// A person's chat with the AI about a Project or a Feature. Only its owner reads it.

/** The longest message a person can send. */
export const MAX_CONVERSATION_MESSAGE_CHARS = 20_000;
/** A Conversation's title: the start of its first message, on one line. */
export const MAX_CONVERSATION_TITLE_CHARS = 80;

/** What a Conversation is about: a Project as a whole, or one Feature. */
export const ConversationScopeInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PROJECT'), projectId: Id }),
  z.object({ kind: z.literal('FEATURE'), featureId: Id }),
]);
export type ConversationScopeInput = z.infer<typeof ConversationScopeInput>;

export const ConversationScopeView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PROJECT'), project: ProjectRef }),
  z.object({ kind: z.literal('FEATURE'), project: ProjectRef, feature: FeatureRef }),
]);
export type ConversationScopeView = z.infer<typeof ConversationScopeView>;

const MessageContent = z
  .string()
  .trim()
  .min(1, 'The message is empty')
  .max(MAX_CONVERSATION_MESSAGE_CHARS);

/** `POST /conversations`: a new Conversation and its first message. */
export const StartConversationInput = z.object({
  scope: ConversationScopeInput,
  content: MessageContent,
});
export type StartConversationInput = z.infer<typeof StartConversationInput>;

/** `POST /conversations/:id/messages`. */
export const SendConversationMessageInput = z.object({ content: MessageContent });
export type SendConversationMessageInput = z.infer<typeof SendConversationMessageInput>;

/**
 * `GET /conversations`: the viewer's own Conversations, the most recently active
 * first. `?recent` (the Sidebar) shows the 10 latest unless `limit` says otherwise;
 * without it, up to 50. `projectId` or `featureId` keep those of one scope.
 */
export const ListConversationsQuery = z.object({
  recent: z.enum(['', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  projectId: Id.optional(),
  featureId: Id.optional(),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuery>;

/** A tool the AI called in a reply (Action Cards, ticket 0043). */
export const ConversationToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});
export type ConversationToolCall = z.infer<typeof ConversationToolCall>;

export const ConversationMessageView = z.object({
  id: Id,
  role: ConversationMessageRole,
  content: z.string(),
  /** ASSISTANT: the tools it called, if any. */
  toolCalls: z.array(ConversationToolCall).nullable(),
  /** TOOL: the call this result answers. */
  toolCallId: z.string().nullable(),
  createdAt: Timestamp,
});
export type ConversationMessageView = z.infer<typeof ConversationMessageView>;

/**
 * Set on a Grilling Conversation (ticket 0044): the Grilling and the round its
 * owner answers there, as a holder of `role`. Its scope is always the Project.
 */
export const GrillingConversationRef = z.object({
  /** The Grilling. */
  id: Id,
  round: GrillingRoundKind,
  role: TeamRole,
});
export type GrillingConversationRef = z.infer<typeof GrillingConversationRef>;

/**
 * A question of the round, as the owner of a Grilling Conversation sees it:
 * - ANSWERED: someone holding the role answered it (here, in their own
 *   Conversation, or through the Grilling API); `answeredBy` says who;
 * - ASKING: the question this Conversation is asking now;
 * - OPEN: not answered yet, and not asked here yet;
 * - SKIPPED: the owner skipped it here (someone else may still answer it), or
 *   the round was skipped before anyone did.
 */
export const GrillingConversationQuestion = z.object({
  id: Id,
  position: z.int().nonnegative(),
  text: z.string(),
  status: z.enum(['ANSWERED', 'ASKING', 'OPEN', 'SKIPPED']),
  answeredBy: PersonRef.nullable(),
  answeredAt: Timestamp.nullable(),
  /** ASKING: the follow-ups asked on it so far. */
  followUpsAsked: z.int().nonnegative(),
});
export type GrillingConversationQuestion = z.infer<typeof GrillingConversationQuestion>;

/** A Grilling Conversation's round and its progress, e.g. "3 of 5 answered". */
export const GrillingConversationProgress = z.object({
  grillingStatus: GrillingStatus,
  roundStatus: GrillingRoundStatus,
  answered: z.int().nonnegative(),
  total: z.int().nonnegative(),
  questions: z.array(GrillingConversationQuestion),
});
export type GrillingConversationProgress = z.infer<typeof GrillingConversationProgress>;

/** A Conversation in a list, without its messages. */
export const ConversationListItem = z.object({
  id: Id,
  title: z.string(),
  scope: ConversationScopeView,
  /** Set when this is a Grilling Conversation. */
  grilling: GrillingConversationRef.nullable(),
  createdAt: Timestamp,
  /** When the last message was written. */
  updatedAt: Timestamp,
});
export type ConversationListItem = z.infer<typeof ConversationListItem>;

export const ConversationList = z.object({ conversations: z.array(ConversationListItem) });
export type ConversationList = z.infer<typeof ConversationList>;

/** A Conversation with all its messages and Action Cards, oldest first. */
export const ConversationView = ConversationListItem.extend({
  messages: z.array(ConversationMessageView),
  /** Each is linked to the message that made it (`messageId`). */
  actionCards: z.array(ActionCardView),
  /** A Grilling Conversation's round and where each question stands; null otherwise. */
  grillingProgress: GrillingConversationProgress.nullable(),
});
export type ConversationView = z.infer<typeof ConversationView>;

/**
 * `POST /conversations/:id/messages` and `.../retry`: the person's message and
 * the AI's reply, once the reply's stream has completed and it is stored.
 */
export const ConversationTurnView = z.object({
  conversation: ConversationListItem,
  message: ConversationMessageView,
  /**
   * What the AI wrote before its reply in this turn, oldest first: each message
   * that called tools, followed by the TOOL messages with their results.
   */
  steps: z.array(ConversationMessageView),
  reply: ConversationMessageView,
  /** The Action Cards this turn's tool calls made. */
  actionCards: z.array(ActionCardView),
});
export type ConversationTurnView = z.infer<typeof ConversationTurnView>;

/**
 * The 502 body when the AI fails mid-reply. Nothing of the reply is stored; the
 * person's message is, so `POST /conversations/:id/retry` asks again.
 * `conversationId` lets a client that just started the Conversation find it.
 */
export const ConversationReplyFailed = z.object({
  statusCode: z.literal(502),
  error: z.string(),
  message: z.string(),
  conversationId: Id,
});
export type ConversationReplyFailed = z.infer<typeof ConversationReplyFailed>;

// ─── Streaming over GET /events (to the owner only) ─────────────────────────

/** The next piece of a reply being written. `messageId` is the id the reply is stored under. */
export const ConversationDeltaEvent = z.object({
  conversationId: Id,
  messageId: Id,
  delta: z.string(),
});
export type ConversationDeltaEvent = z.infer<typeof ConversationDeltaEvent>;

/** The reply is complete and stored. */
export const ConversationDoneEvent = z.object({
  conversationId: Id,
  message: ConversationMessageView,
});
export type ConversationDoneEvent = z.infer<typeof ConversationDoneEvent>;

/**
 * The AI called tools: its message (the text streamed so far, and the calls)
 * and the TOOL messages with each call's result are stored. The reply goes on
 * with new `conversation.delta`s under a new `messageId`.
 */
export const ConversationStepEvent = z.object({
  conversationId: Id,
  messages: z.array(ConversationMessageView),
});
export type ConversationStepEvent = z.infer<typeof ConversationStepEvent>;

/**
 * The AI failed mid-reply: drop the text streamed under `messageId`; it wasn't
 * stored. Steps already announced by `conversation.step` stay.
 */
export const ConversationFailedEvent = z.object({
  conversationId: Id,
  messageId: Id,
  message: z.string(),
});
export type ConversationFailedEvent = z.infer<typeof ConversationFailedEvent>;

/**
 * The server added messages to a Conversation outside a reply: in a Grilling
 * Conversation, when someone else answered the question it was asking, or its
 * round ended (ticket 0044). Each is stored.
 */
export const ConversationAppendedEvent = z.object({
  conversationId: Id,
  messages: z.array(ConversationMessageView),
});
export type ConversationAppendedEvent = z.infer<typeof ConversationAppendedEvent>;
