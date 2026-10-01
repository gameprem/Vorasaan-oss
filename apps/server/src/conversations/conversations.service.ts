import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  type ActionCardView,
  type ConversationList,
  type ConversationListItem,
  type ConversationMessageView,
  type ConversationScopeInput,
  type ConversationTurnView,
  type ConversationView,
  type ListConversationsQuery,
  MAX_CONVERSATION_TITLE_CHARS,
  type ServerEvent,
} from '@vorasaan/shared';
import { ActionCardsService } from '../action-cards/action-cards.service.ts';
import {
  AI_PORT,
  type AiPort,
  type ChatMessageForAi,
  type ChatToolCall,
  type ContextBlock,
  type ConversationScopeForAi,
  type ProjectFoundationForAi,
} from '../ai/ai.port.ts';
import { clipForAi } from '../attachments/attachment-context.ts';
import { projectAccess } from '../brief/brief-access.ts';
import { FeatureGuidelinesService } from '../feature-guidelines/feature-guidelines.service.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import {
  CONTEXT_BUDGET,
  ContextRetriever,
  splitProjectBrief,
} from '../retrieval/context-retriever.ts';
import {
  type ConversationWithScope,
  conversationInclude,
  toConversationListItem,
  toConversationMessageView,
  toConversationView,
} from './conversation.view.ts';

/** How much of a Conversation the AI gets on each turn, besides its retrieved context (ADR 0007). */
export const CONVERSATION_LIMITS = {
  /** At most this many messages after the summary are sent; past it, the oldest are folded in. */
  maxRecentMessages: 12,
  /** A fold leaves this many of the newest messages out of the summary. */
  keepRecentMessages: 6,
  /** The summary is cut to this many characters. */
  maxSummaryChars: 4_000,
} as const;

/**
 * The most rounds of tool calls in one turn (Action Cards, 0043). After them the
 * AI is asked once more without tools, so it must answer in words.
 */
export const MAX_TOOL_ROUNDS = 4;

const LIST_LIMIT = { recent: 10, all: 50 } as const;

type MessageRow = Prisma.ConversationMessageGetPayload<object>;
type Turn = {
  conversation: ConversationListItem;
  message: MessageRow;
  steps: MessageRow[];
  reply: MessageRow;
  actionCards: ActionCardView[];
};

/**
 * Conversations (ADR 0008, ticket 0042): a person's chat with the AI about a
 * Project or a Feature. Only the owner reads, writes or deletes one; anyone
 * else, an Admin included, gets 404.
 *
 * A turn stores the person's message first, then streams the AI's reply to the
 * owner over `GET /events` (`conversation.delta`, then `conversation.done`) and
 * stores the reply only once its stream has completed. When the AI fails, no
 * part of the reply is stored, the owner gets `conversation.failed`, the call
 * is a 502, and the message stays so `retry` can ask again.
 *
 * Each turn the AI gets freshly retrieved context for the scope, the summary of
 * earlier turns and only the messages after it. Past `maxRecentMessages` the
 * oldest of those are folded into the summary first.
 *
 * The AI may call tools (Action Cards, 0043). Each round that calls tools is
 * stored as it completes: the ASSISTANT message with its calls, then one TOOL
 * message per call with its result, announced with `conversation.step` (and
 * `conversation.actionCard.created` for each card). The AI then gets those
 * results and goes on, for at most `MAX_TOOL_ROUNDS` rounds per turn.
 *
 * One reply is written at a time per Conversation; this process holds the lock,
 * as it holds the event bus (one server process per Organization).
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly replying = new Set<string>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly guidelines: FeatureGuidelinesService,
    private readonly bus: EventBus,
    private readonly cards: ActionCardsService,
  ) {}

  /** Anyone in the scope's Organization starts one; the AI replies to the first message. */
  async start(
    user: User,
    input: { scope: ConversationScopeInput; content: string },
  ): Promise<ConversationView> {
    const scope = await this.resolveScope(user, input.scope);
    const id = await this.db.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: { ownerId: user.id, ...scope, title: titleOf(input.content) },
      });
      await tx.conversationMessage.create({
        data: { conversationId: created.id, position: 0, role: 'USER', content: input.content },
      });
      return created.id;
    });
    await this.exclusively(id, () => this.reply(user, id));
    return this.get(user, id);
  }

  async list(user: User, query: ListConversationsQuery): Promise<ConversationList> {
    const rows = await this.db.conversation.findMany({
      where: {
        ownerId: user.id,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.featureId ? { featureId: query.featureId } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit ?? (query.recent === undefined ? LIST_LIMIT.all : LIST_LIMIT.recent),
      include: conversationInclude,
    });
    return { conversations: rows.map(toConversationListItem) };
  }

  async get(user: User, id: string): Promise<ConversationView> {
    const conversation = await this.owned(user, id);
    const messages = await this.db.conversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { position: 'asc' },
    });
    const actionCards = await this.cards.forConversation(user, id);
    return toConversationView(conversation, messages, actionCards);
  }

  /** The owner's next message, and the AI's reply to it. */
  async send(user: User, id: string, content: string): Promise<ConversationTurnView> {
    await this.ownedWithAccess(user, id);
    return this.exclusively(id, async () => {
      await this.db.$transaction(async (tx) => {
        const position = await nextPosition(tx, id);
        await tx.conversationMessage.create({
          data: { conversationId: id, position, role: 'USER', content },
        });
        await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
      });
      return toTurnView(await this.reply(user, id));
    });
  }

  /**
   * Asks the AI again for a reply to the last message, after a failed one. When
   * the failure came after a round of tool calls, that round stays and the AI
   * goes on from its results.
   */
  async retry(user: User, id: string): Promise<ConversationTurnView> {
    await this.ownedWithAccess(user, id);
    return this.exclusively(id, async () => {
      const last = await this.db.conversationMessage.findFirst({
        where: { conversationId: id },
        orderBy: { position: 'desc' },
        select: { role: true },
      });
      if (last?.role !== 'USER' && last?.role !== 'TOOL') {
        throw new ConflictException('Nothing to retry: the last message already has its reply');
      }
      return toTurnView(await this.reply(user, id));
    });
  }

  async delete(user: User, id: string): Promise<void> {
    const { count } = await this.db.conversation.deleteMany({ where: { id, ownerId: user.id } });
    if (!count) throw notFound();
  }

  // ─── A turn ────────────────────────────────────────────────────────────────

  /**
   * Replies to the trailing message: folds old messages into the summary if
   * needed, retrieves the scope's context, then streams the AI's reply to the
   * owner. Each round of tool calls is run and stored, and the AI goes on with
   * the results; the final reply is stored once complete. Call only while
   * holding the Conversation's lock.
   */
  private async reply(user: User, id: string): Promise<Turn> {
    const conversation = await this.db.conversation.findUniqueOrThrow({
      where: { id },
      include: {
        ...conversationInclude,
        feature: { select: { id: true, title: true, description: true } },
      },
    });
    const rows = await this.db.conversationMessage.findMany({
      where: { conversationId: id, position: { gte: conversation.summarizedThrough } },
      orderBy: { position: 'asc' },
    });
    if (!rows.length) throw new Error(`Conversation ${id} has no message to reply to`);
    // The person's message this turn answers (a retry may follow a tool round).
    const message = await this.db.conversationMessage.findFirstOrThrow({
      where: { conversationId: id, role: 'USER' },
      orderBy: { position: 'desc' },
    });
    const scope = scopeForAi(conversation);
    const { summary, recent } = await this.fold(conversation, scope, rows);
    const { context, foundation } = await this.contextFor(conversation, recent);

    const tools = this.cards.toolsFor(conversation);
    const recentMessages = recent.map(toChatMessage);
    const steps: MessageRow[] = [];
    const actionCards: ActionCardView[] = [];
    const emit = (event: ServerEvent) => this.bus.emit(user.id, event);

    for (let round = 0; ; round++) {
      // Past the last tool round the AI gets no tools, so it must answer in words.
      const offered = round < MAX_TOOL_ROUNDS ? tools : [];
      const replyId = randomUUID();
      let text = '';
      const toolCalls: ChatToolCall[] = [];
      try {
        const stream = this.ai.chat({
          scope,
          context,
          foundation,
          summary,
          recentMessages: [...recentMessages],
          tools: offered,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            if (!chunk.delta) continue;
            text += chunk.delta;
            emit({
              event: 'conversation.delta',
              data: { conversationId: id, messageId: replyId, delta: chunk.delta },
            });
          } else if (!offered.some((t) => t.name === chunk.call.name)) {
            this.logger.warn(
              `Dropped a call to the tool "${chunk.call.name}", which wasn't offered`,
            );
          } else if (toolCalls.some((c) => c.id === chunk.call.id)) {
            this.logger.warn(`Dropped a second tool call with the id "${chunk.call.id}"`);
          } else {
            toolCalls.push(chunk.call);
          }
        }
      } catch (error) {
        this.logger.error('A Conversation reply failed', error as Error);
        const reason = 'The AI failed while replying, so no reply was saved. Try again.';
        emit({
          event: 'conversation.failed',
          data: { conversationId: id, messageId: replyId, message: reason },
        });
        throw replyFailed(id, reason);
      }

      if (!toolCalls.length) {
        const saved = await this.store(id, { id: replyId, role: 'ASSISTANT', content: text });
        emit({
          event: 'conversation.done',
          data: { conversationId: id, message: toConversationMessageView(saved.message) },
        });
        return {
          conversation: toConversationListItem(saved.conversation),
          message,
          steps,
          reply: saved.message,
          actionCards,
        };
      }

      // A round of tool calls: store the calls, then run each and store its result.
      const step = await this.store(id, {
        id: replyId,
        role: 'ASSISTANT',
        content: text,
        toolCalls: toolCalls as Prisma.InputJsonValue,
      });
      const results: MessageRow[] = [];
      const made: ActionCardView[] = [];
      for (const call of toolCalls) {
        const run = await this.cards.run(user, conversation, step.message.id, call);
        const result = await this.store(id, {
          role: 'TOOL',
          content: run.content,
          toolCallId: call.id,
        });
        results.push(result.message);
        made.push(...run.cards);
      }
      emit({
        event: 'conversation.step',
        data: {
          conversationId: id,
          messages: [step.message, ...results].map(toConversationMessageView),
        },
      });
      for (const card of made) {
        emit({ event: 'conversation.actionCard.created', data: { conversationId: id, card } });
      }
      steps.push(step.message, ...results);
      actionCards.push(...made);
      recentMessages.push(toChatMessage(step.message), ...results.map(toChatMessage));
    }
  }

  /** Appends a message to the Conversation, which counts as activity. */
  private store(
    id: string,
    data: Omit<Prisma.ConversationMessageUncheckedCreateInput, 'conversationId' | 'position'>,
  ) {
    return this.db.$transaction(async (tx) => {
      const conversation = await tx.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
        include: conversationInclude,
      });
      const message = await tx.conversationMessage.create({
        data: { ...data, conversationId: id, position: await nextPosition(tx, id) },
      });
      return { conversation, message };
    });
  }

  /**
   * The summary and the messages to send. Past `maxRecentMessages`, all but the
   * newest `keepRecentMessages` are folded into the summary, which is saved
   * before the reply, so a failed reply never folds them twice.
   */
  private async fold(
    conversation: { id: string; summary: string; summarizedThrough: number },
    scope: ConversationScopeForAi,
    rows: MessageRow[],
  ): Promise<{ summary: string; recent: MessageRow[] }> {
    const { maxRecentMessages, keepRecentMessages, maxSummaryChars } = CONVERSATION_LIMITS;
    if (rows.length <= maxRecentMessages) return { summary: conversation.summary, recent: rows };
    const older = rows.slice(0, rows.length - keepRecentMessages);
    const recent = rows.slice(rows.length - keepRecentMessages);
    let summary: string;
    try {
      const folded = await this.ai.summarizeConversation({
        scope,
        summary: conversation.summary,
        messages: older.map(toChatMessage),
      });
      summary = clipForAi(folded.summary.trim(), maxSummaryChars);
    } catch (error) {
      this.logger.error('Folding a Conversation into its summary failed', error as Error);
      throw replyFailed(
        conversation.id,
        'The AI failed while summarizing earlier messages, so no reply was saved. Try again.',
      );
    }
    const through = recent[0]?.position ?? conversation.summarizedThrough;
    await this.db.conversation.update({
      where: { id: conversation.id },
      data: { summary, summarizedThrough: through },
    });
    return { summary, recent };
  }

  /**
   * The scope's retrieved context for this turn, queried with the person's
   * newest messages, within the same budgets as the other workflows: a Feature
   * gets its own Spec, Decisions and Attachments first (with the Brief and the
   * Guidelines), a Project its Brief, Features and Project Attachments.
   */
  private async contextFor(
    conversation: { projectId: string; featureId: string | null },
    recent: MessageRow[],
  ): Promise<{ context: ContextBlock[]; foundation: ProjectFoundationForAi }> {
    // The person's newest messages, before any tool round of the turn being replied to.
    const trailing: string[] = [];
    let i = recent.length - 1;
    while (i >= 0 && recent[i]?.role !== 'USER') i--;
    for (; i >= 0 && recent[i]?.role === 'USER'; i--) trailing.unshift(recent[i]?.content ?? '');
    const query = trailing.join('\n\n');
    if (conversation.featureId) {
      const { foundation, contextBudget } = await this.foundation.forFeature(
        conversation.featureId,
        CONTEXT_BUDGET.conversationFeature,
      );
      const context = await this.retriever.forFeature(conversation.featureId, query, contextBudget);
      return { context: withoutBrief(context), foundation };
    }
    const [blocks, criteria] = await Promise.all([
      this.retriever.forProject(conversation.projectId, query, CONTEXT_BUDGET.conversationProject),
      this.guidelines.effective(conversation.projectId),
    ]);
    const { brief, context } = splitProjectBrief(blocks);
    return {
      context,
      foundation: {
        brief: brief ? { version: brief.source.version ?? 0, markdown: brief.text } : null,
        guidelines: criteria.map((c) => ({
          title: c.title,
          description: c.description,
          kind: c.kind,
          required: c.required,
        })),
      },
    };
  }

  // ─── Access ────────────────────────────────────────────────────────────────

  /** The Conversation, if the user owns it; 404 otherwise, whoever asks. */
  private async owned(user: User, id: string): Promise<ConversationWithScope> {
    const conversation = await this.db.conversation.findFirst({
      where: { id, ownerId: user.id },
      include: conversationInclude,
    });
    if (!conversation) throw notFound();
    return conversation;
  }

  /**
   * The Conversation, if the user owns it and may still read its Project: a reply reads
   * the Project's context, so someone who left the Organization gets 403, not answers.
   */
  private async ownedWithAccess(user: User, id: string): Promise<ConversationWithScope> {
    const conversation = await this.owned(user, id);
    await projectAccess(this.db, user, conversation.projectId);
    return conversation;
  }

  /** The Project (and Feature) a new Conversation is about, once the user may read it. */
  private async resolveScope(
    user: User,
    scope: ConversationScopeInput,
  ): Promise<{ projectId: string; featureId: string | null }> {
    if (scope.kind === 'PROJECT') {
      await projectAccess(this.db, user, scope.projectId);
      return { projectId: scope.projectId, featureId: null };
    }
    const feature = await this.db.feature.findUnique({
      where: { id: scope.featureId },
      select: { id: true, team: { select: { projectId: true } } },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    await projectAccess(this.db, user, feature.team.projectId);
    return { projectId: feature.team.projectId, featureId: feature.id };
  }

  /** Runs `work` while no other reply is being written in this Conversation. */
  private async exclusively<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.replying.has(id)) {
      throw new ConflictException('A reply is still being written in this Conversation');
    }
    this.replying.add(id);
    try {
      return await work();
    } finally {
      this.replying.delete(id);
    }
  }
}

function notFound() {
  return new NotFoundException('Conversation not found');
}

/** A 502 that tells a client which Conversation to retry in (ConversationReplyFailed). */
function replyFailed(conversationId: string, message: string) {
  return new BadGatewayException({
    statusCode: 502,
    error: 'Bad Gateway',
    message,
    conversationId,
  });
}

/** The first line of the first message, shortened. */
function titleOf(content: string): string {
  const line = (content.trim().split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= MAX_CONVERSATION_TITLE_CHARS) return line;
  return `${line.slice(0, MAX_CONVERSATION_TITLE_CHARS - 1).trimEnd()}…`;
}

async function nextPosition(tx: Prisma.TransactionClient, conversationId: string) {
  const { _max } = await tx.conversationMessage.aggregate({
    where: { conversationId },
    _max: { position: true },
  });
  return (_max.position ?? -1) + 1;
}

function scopeForAi(c: {
  project: { name: string };
  feature: { title: string; description: string | null } | null;
}): ConversationScopeForAi {
  const project = { name: c.project.name };
  if (!c.feature) return { kind: 'PROJECT', project };
  return {
    kind: 'FEATURE',
    project,
    feature: { title: c.feature.title, description: c.feature.description ?? '' },
  };
}

function toChatMessage(m: MessageRow): ChatMessageForAi {
  if (m.role === 'USER') return { role: 'USER', content: m.content };
  if (m.role === 'TOOL')
    return { role: 'TOOL', content: m.content, toolCallId: m.toolCallId ?? '' };
  const toolCalls = toConversationMessageView(m).toolCalls;
  return toolCalls?.length
    ? { role: 'ASSISTANT', content: m.content, toolCalls }
    : { role: 'ASSISTANT', content: m.content };
}

function toTurnView(turn: Turn): ConversationTurnView {
  return {
    conversation: turn.conversation,
    message: toConversationMessageView(turn.message) satisfies ConversationMessageView,
    steps: turn.steps.map(toConversationMessageView),
    reply: toConversationMessageView(turn.reply),
    actionCards: turn.actionCards,
  };
}
