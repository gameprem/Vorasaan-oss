import { z } from 'zod';
import { ActionCardView } from './action-card.ts';
import { RecordedModel } from './ai-settings.ts';
import { PersonRef } from './decision-request.ts';
import {
  ConversationMessageRole,
  GrillingRoundKind,
  GrillingRoundStatus,
  GrillingStatus,
  TeamRole,
} from './enums.ts';
import { GrillingFollowUp } from './grilling.ts';
import { GrillingNote } from './grilling-notes.ts';

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

/**
 * The Approved Model to reply with, picked in the composer (ticket 0054). The
 * Conversation keeps it for its next messages. It must be one of the
 * Organization's Approved Models (422 otherwise).
 */
const PickedModel = Id.optional();

/** `POST /conversations`: a new Conversation and its first message. */
export const StartConversationInput = z.object({
  scope: ConversationScopeInput,
  content: MessageContent,
  approvedModelId: PickedModel,
});
export type StartConversationInput = z.infer<typeof StartConversationInput>;

/** `POST /conversations/:id/messages`. */
export const SendConversationMessageInput = z.object({
  content: MessageContent,
  approvedModelId: PickedModel,
});
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
  /**
   * Where it stands in the Conversation, from 0 in the order written (ticket 0066).
   * Unique per Conversation: pages and a client's merge order by it.
   */
  position: z.int().nonnegative(),
  role: ConversationMessageRole,
  content: z.string(),
  /** ASSISTANT: the tools it called, if any. */
  toolCalls: z.array(ConversationToolCall).nullable(),
  /** TOOL: the call this result answers. */
  toolCallId: z.string().nullable(),
  /** ASSISTANT: the model that wrote it (ticket 0054); null for the server's own messages. */
  model: RecordedModel.nullable(),
  /**
   * ASSISTANT: set on the one reply after the Conversation's model was removed,
   * saying which model it used instead.
   */
  modelNotice: z.string().nullable(),
  /**
   * ASSISTANT, in a Grilling Conversation: what the server wrote, as Grilling Notes
   * (ticket 0047), so a client can show it in the reader's language and show notices
   * quietly. `content` is the same in English. Null for anything else.
   */
  grillingNotes: z.array(GrillingNote).nullable(),
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
  /** ANSWERED: the answer and the follow-ups asked in the answerer's Conversation (0047). */
  answer: z.string().nullable(),
  followUps: z.array(GrillingFollowUp),
  /** ASKING: the follow-ups asked on it so far. */
  followUpsAsked: z.int().nonnegative(),
});
export type GrillingConversationQuestion = z.infer<typeof GrillingConversationQuestion>;

/**
 * One of the Grilling's three rounds, for the header of a Grilling Conversation
 * (ticket 0047): UPCOMING until the Grilling reaches it, then ASKING, ANSWERED or
 * SKIPPED, with how many of its questions have an answer.
 */
export const GrillingRoundProgress = z.object({
  kind: GrillingRoundKind,
  role: TeamRole,
  status: z.union([GrillingRoundStatus, z.literal('UPCOMING')]),
  answered: z.int().nonnegative(),
  total: z.int().nonnegative(),
});
export type GrillingRoundProgress = z.infer<typeof GrillingRoundProgress>;

/** A Grilling Conversation's round and its progress, e.g. "3 of 5 answered". */
export const GrillingConversationProgress = z.object({
  grillingStatus: GrillingStatus,
  roundStatus: GrillingRoundStatus,
  answered: z.int().nonnegative(),
  total: z.int().nonnegative(),
  questions: z.array(GrillingConversationQuestion),
  /** Every round of the Grilling, in the order they are asked (0047). */
  rounds: z.array(GrillingRoundProgress),
});
export type GrillingConversationProgress = z.infer<typeof GrillingConversationProgress>;

/** A Conversation in a list, without its messages. */
export const ConversationListItem = z.object({
  id: Id,
  title: z.string(),
  scope: ConversationScopeView,
  /** Set when this is a Grilling Conversation. */
  grilling: GrillingConversationRef.nullable(),
  /**
   * The Approved Model picked in this Conversation (ticket 0054); its next reply
   * runs on it. Null until someone picks one, or after it was removed: the
   * Conversation then runs on the chat default (`GET /ai/models`).
   */
  modelId: Id.nullable(),
  /**
   * How many of the oldest messages were summarized (ticket 0060): the AI now
   * reads them only through the Conversation Summary. They stay stored and shown
   * as usual (ticket 0066: a divider marks each compaction). 0 before any.
   */
  summarizedThrough: z.int().nonnegative(),
  createdAt: Timestamp,
  /** When the last message was written. */
  updatedAt: Timestamp,
});
export type ConversationListItem = z.infer<typeof ConversationListItem>;

export const ConversationList = z.object({ conversations: z.array(ConversationListItem) });

// ─── Compactions (ticket 0066) ──────────────────────────────────────────────

/** What folded the history: a turn past its threshold, a person, or a provider's "too long". */
export const ConversationCompactionTrigger = z.enum(['AUTO', 'MANUAL', 'TOO_LONG']);
export type ConversationCompactionTrigger = z.infer<typeof ConversationCompactionTrigger>;

/** The longest focus `/compact` takes: what the person wants the summary to keep. */
export const MAX_COMPACTION_FOCUS_CHARS = 500;

/**
 * One compaction of a Conversation (ADR 0012): the messages before `beforeMessageId`
 * were folded into the Conversation Summary. A client draws a divider above that
 * message; the messages above it stay readable.
 */
export const ConversationCompactionView = z.object({
  id: Id,
  /** 1 for the first compaction of the Conversation, then 2, 3… */
  number: z.int().positive(),
  trigger: ConversationCompactionTrigger,
  /** What the person asked the summary to keep (`/compact <focus>`); null otherwise. */
  focus: z.string().nullable(),
  /** How many of the oldest messages the AI reads only through the summary since then. */
  summarizedThrough: z.int().nonnegative(),
  /** The first message still read word for word after it; the divider goes above it. */
  beforeMessageId: Id.nullable(),
  /** Who compacted it by hand; null for an automatic compaction. */
  createdBy: PersonRef.nullable(),
  createdAt: Timestamp,
});
export type ConversationCompactionView = z.infer<typeof ConversationCompactionView>;

/** One section of a Conversation Summary, e.g. "Agreed" and its items. */
export const ConversationSummarySection = z.object({
  heading: z.string(),
  items: z.array(z.string()),
});
export type ConversationSummarySection = z.infer<typeof ConversationSummarySection>;

/**
 * `GET /conversations/:id/compactions/:compactionId`: the Conversation Summary as
 * that compaction left it. Read-only: the summary is the AI's own notes, and a
 * person changes what it keeps with `/compact <focus>` or by recording the point in
 * the Spec or the Brief.
 */
export const ConversationCompactionSummary = ConversationCompactionView.extend({
  /** The summary as Markdown, one `##` heading per section. */
  summary: z.string(),
  sections: z.array(ConversationSummarySection),
  /** Whether this is the summary the AI reads now (the latest compaction). */
  current: z.boolean(),
});
export type ConversationCompactionSummary = z.infer<typeof ConversationCompactionSummary>;

/** `POST /conversations/:id/compact`: compact now (the meter's "Compact now", `/compact [focus]`). */
export const CompactConversationInput = z.object({
  focus: z.string().trim().max(MAX_COMPACTION_FOCUS_CHARS).optional(),
  /**
   * Compact without first offering to record agreed points in the Spec or the
   * Brief: the person acted on that Action Card, or skipped it.
   */
  skipRecordCheck: z.boolean().optional(),
});
export type CompactConversationInput = z.infer<typeof CompactConversationInput>;

// ─── Usage and the context meter (ticket 0066) ──────────────────────────────

/**
 * How full a Conversation is, for the model its next reply runs on (or the one
 * asked about), in tokens: the server's own budget plan (ticket 0060, ADR 0012).
 */
export const ConversationUsage = z.object({
  conversationId: Id,
  /** The model these numbers are for. */
  model: RecordedModel,
  /** The model's Context Window, prompt and reply together. */
  contextWindow: z.int().nonnegative(),
  /** The shares of the window a turn plans with; they add up to at most the window. */
  plan: z.object({
    /** The system prompt: instructions, tools, wrappers. */
    system: z.int().nonnegative(),
    /** The Project Brief and the Guidelines. */
    foundation: z.int().nonnegative(),
    /** Retrieved context. */
    context: z.int().nonnegative(),
    /** The Conversation Summary and the messages after it. */
    history: z.int().nonnegative(),
    /** Room for the reply and the turn's tool rounds. */
    reply: z.int().nonnegative(),
  }),
  /** The history against its share. */
  history: z.object({
    /** What the Conversation Summary and the messages after it cost now. */
    used: z.int().nonnegative(),
    /** The history's share of the window (`plan.history`). */
    share: z.int().nonnegative(),
    /** Past this, the next turn compacts first. */
    compactAt: z.int().nonnegative(),
    /** From here a client warns that compaction is near. */
    warnAt: z.int().nonnegative(),
    /** `used` as a part of `share`, from 0 (more than 1 when one long message overflows it). */
    fraction: z.number().nonnegative(),
  }),
  /** The last reply's input, and how much of it the provider read from its cache (0061). */
  lastTurn: z
    .object({
      inputTokens: z.int().nonnegative().nullable(),
      cacheReadTokens: z.int().nonnegative().nullable(),
    })
    .nullable(),
});
export type ConversationUsage = z.infer<typeof ConversationUsage>;

/** `GET /conversations/:id/usage`: for the Conversation's model, or the one picked. */
export const ConversationUsageQuery = z.object({ approvedModelId: Id.optional() });
export type ConversationUsageQuery = z.infer<typeof ConversationUsageQuery>;

// ─── Pages of messages (ticket 0066) ────────────────────────────────────────

/** The messages a page holds unless `limit` says otherwise. */
export const MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 100;

/**
 * Where a page starts or ends: opaque to a client, which only sends back a cursor
 * it was given. It names one message, so pages never skip or repeat a message,
 * whatever arrives meanwhile.
 */
export const MessageCursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/, 'Not a cursor from this API');
export type MessageCursor = z.infer<typeof MessageCursor>;

const PageLimit = z.coerce.number().int().min(1).max(MAX_MESSAGE_PAGE_SIZE).optional();

/**
 * `GET /conversations/:id/messages`: the latest page; `before` the page older than
 * a cursor, `after` the one newer; `around` the page around a message (a deep
 * link). At most one of the three.
 */
export const ListConversationMessagesQuery = z
  .object({
    before: MessageCursor.optional(),
    after: MessageCursor.optional(),
    around: Id.optional(),
    limit: PageLimit,
  })
  .refine(
    (q) => [q.before, q.after, q.around].filter((v) => v !== undefined).length <= 1,
    'Give at most one of before, after and around',
  );
export type ListConversationMessagesQuery = z.infer<typeof ListConversationMessagesQuery>;

/** `GET /conversations/:id`: the latest page of messages, or the page `around` a message. */
export const GetConversationQuery = z.object({ around: Id.optional(), limit: PageLimit });
export type GetConversationQuery = z.infer<typeof GetConversationQuery>;

/** Where a page of messages sits: a cursor each way while there is more that way, else null. */
export const MessagePageInfo = z.object({
  /** Pass as `before` for the page older than this one; null from the first message. */
  olderCursor: MessageCursor.nullable(),
  /** Pass as `after` for the page newer than this one; null at the latest message. */
  newerCursor: MessageCursor.nullable(),
});
export type MessagePageInfo = z.infer<typeof MessagePageInfo>;

/** A page of a Conversation's messages, oldest first. */
export const ConversationMessagePage = MessagePageInfo.extend({
  messages: z.array(ConversationMessageView),
});
export type ConversationMessagePage = z.infer<typeof ConversationMessagePage>;
export type ConversationList = z.infer<typeof ConversationList>;

/**
 * A Conversation with a page of its messages (the latest, or the one around a
 * message; ticket 0066), and all its Action Cards and compactions, oldest first.
 */
export const ConversationView = ConversationListItem.extend({
  messages: z.array(ConversationMessageView),
  /** Where `messages` sits; older and newer pages come from `GET /conversations/:id/messages`. */
  page: MessagePageInfo,
  /** Every compaction, oldest first: a client draws a divider for each. */
  compactions: z.array(ConversationCompactionView),
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
  /** How full the Conversation is after the turn (ticket 0066); null in a Grilling Conversation. */
  usage: ConversationUsage.nullable(),
});
export type ConversationTurnView = z.infer<typeof ConversationTurnView>;

/**
 * `POST /conversations/:id/stop` (ticket 0046): the reply being written there is
 * stopped. What it had written so far is kept as the reply, and the call that
 * asked for it answers as usual. 409 when no reply is being written.
 */
export const StopConversationResult = z.object({ stopped: z.literal(true) });
export type StopConversationResult = z.infer<typeof StopConversationResult>;

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

/** How full the Conversation is, after a turn or a compaction (ticket 0066). */
export const ConversationUsageEvent = z.object({
  conversationId: Id,
  usage: ConversationUsage,
});
export type ConversationUsageEvent = z.infer<typeof ConversationUsageEvent>;

/** The history was folded into the Conversation Summary (ticket 0066): one more divider. */
export const ConversationCompactedEvent = z.object({
  conversationId: Id,
  compaction: ConversationCompactionView,
  summarizedThrough: z.int().nonnegative(),
});
export type ConversationCompactedEvent = z.infer<typeof ConversationCompactedEvent>;

/**
 * `POST /conversations/:id/compact`: COMPACTED, or RECORD_FIRST when agreed points
 * aren't in the Spec or the Brief yet. Then the AI offered an Action Card to record
 * them (its message and the card are in `messages` and `card`); compact again with
 * `skipRecordCheck` once the person acted on it or skipped it.
 */
export const CompactConversationResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('COMPACTED'),
    conversation: ConversationListItem,
    compaction: ConversationCompactionView,
    usage: ConversationUsage,
  }),
  z.object({
    status: z.literal('RECORD_FIRST'),
    /** The agreed points not recorded yet. */
    unrecorded: z.array(z.string()),
    /** The AI's message offering the card, and its tool result. */
    messages: z.array(ConversationMessageView),
    card: ActionCardView,
  }),
]);
export type CompactConversationResult = z.infer<typeof CompactConversationResult>;
