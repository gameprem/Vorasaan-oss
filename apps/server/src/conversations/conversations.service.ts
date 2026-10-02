import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
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
  type RecordedModel,
  type ServerEvent,
  type StopConversationResult,
} from '@vorasaan/shared';
import { ActionCardsService } from '../action-cards/action-cards.service.ts';
import {
  AI_PORT,
  type AiPort,
  type ChatMessageForAi,
  type ChatToolCall,
  type ContextBlock,
  ContextTooLongError,
  type ConversationScopeForAi,
  type ModelChoice,
  type ProjectFoundationForAi,
} from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { BUDGET_CONFIG, type Budget, ContextBudgets, projectBudget } from '../ai/context-budget.ts';
import { renderConversationSummary } from '../ai/prompts.ts';
import {
  fromRecordedModelColumns,
  modelLabel,
  toRecordedModelColumns,
} from '../ai/recorded-model.ts';
import { estimateMessageTokens, MESSAGE_OVERHEAD_TOKENS } from '../ai/token-count.ts';
import { projectAccess } from '../brief/brief-access.ts';
import { FeatureGuidelinesService } from '../feature-guidelines/feature-guidelines.service.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import {
  GrillingConversationsService,
  type GrillingTurn,
} from '../grilling/grilling-conversations.service.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ContextRetriever, splitProjectBrief } from '../retrieval/context-retriever.ts';
import { clipToTokens, estimateTokens } from '../retrieval/token-estimate.ts';
import {
  type ConversationWithScope,
  conversationInclude,
  toConversationListItem,
  toConversationMessageView,
  toConversationView,
} from './conversation.view.ts';
import { conversationNotFound as notFound, replyFailed } from './conversation-errors.ts';
import { ConversationLocks } from './conversation-locks.ts';

/**
 * The most rounds of tool calls in one turn (Action Cards, 0043). After them the
 * AI is asked once more without tools, so it must answer in words.
 */
export const MAX_TOOL_ROUNDS = 4;

const LIST_LIMIT = { recent: 10, all: 50 } as const;

type MessageRow = Prisma.ConversationMessageGetPayload<object>;
/** The model a turn runs on, chosen once before its first step, and what is recorded of it. */
type TurnModel = { choice: ModelChoice; record: RecordedModel; notice: string | null };
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
 * Each turn the AI gets freshly retrieved context for the scope, the
 * Conversation Summary of earlier turns and only the messages after it, each
 * within its share of the turn's model's window (ticket 0060, ADR 0012). When the
 * history passes `BUDGET_CONFIG.compaction.at` of its share (counted once per
 * turn with `AiPort.countTokens`), it is compacted first: the newest turns are
 * kept word for word and the rest is folded into the Conversation Summary.
 * Messages stay stored; only what is sent to the AI shrinks. When the provider
 * still rejects the request as too long, the Conversation compacts at once and
 * retries one time before reporting the failure.
 *
 * The AI may call tools (Action Cards, 0043). Each round that calls tools is
 * stored as it completes: the ASSISTANT message with its calls, then one TOOL
 * message per call with its result, announced with `conversation.step` (and
 * `conversation.actionCard.created` for each card). The AI then gets those
 * results and goes on, for at most `MAX_TOOL_ROUNDS` rounds per turn.
 *
 * One reply is written at a time per Conversation; this process holds the lock,
 * as it holds the event bus (one server process per Organization).
 *
 * A Grilling Conversation (0044) is answered here too, but its turns go to
 * GrillingConversationsService: the server asks the round's questions and the
 * AI only decides on follow-ups.
 *
 * The model (ticket 0054, ADR 0010): a turn runs on the Approved Model picked in
 * the Conversation (`modelId`), else the chat default. It is chosen once, before
 * the turn's first step, so a reply never switches model midway, and every
 * ASSISTANT message records it. A Conversation whose model was removed falls back
 * on its next turn, and that reply carries a notice.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  /** The replies being written in this process, by Conversation, so `stop` can end one. */
  private readonly replying = new Map<string, AbortController>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly guidelines: FeatureGuidelinesService,
    private readonly bus: EventBus,
    private readonly cards: ActionCardsService,
    private readonly locks: ConversationLocks,
    private readonly grilling: GrillingConversationsService,
    private readonly models: AiSettingsService,
    private readonly budgets: ContextBudgets,
  ) {}

  /** Anyone in the scope's Organization starts one; the AI replies to the first message. */
  async start(
    user: User,
    input: { scope: ConversationScopeInput; content: string; approvedModelId?: string },
  ): Promise<ConversationView> {
    const scope = await this.resolveScope(user, input.scope);
    if (input.approvedModelId) await this.models.assertPickable(input.approvedModelId);
    const id = await this.db.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          ownerId: user.id,
          ...scope,
          title: titleOf(input.content),
          modelId: input.approvedModelId ?? null,
        },
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
    const progress = conversation.grillingRoundId ? await this.grilling.progress(id) : null;
    return toConversationView(conversation, messages, actionCards, progress);
  }

  /** `POST /grillings/:id/conversation`: my Grilling Conversation for the round being asked. */
  async openGrilling(user: User, grillingId: string): Promise<ConversationView> {
    return this.get(user, await this.grilling.open(user, grillingId));
  }

  /**
   * The owner's next message, and the AI's reply to it. `approvedModelId` picks the
   * model for this reply and the next ones (422 unless it is an Approved Model).
   */
  async send(
    user: User,
    id: string,
    content: string,
    approvedModelId?: string,
  ): Promise<ConversationTurnView> {
    const conversation = await this.ownedWithAccess(user, id);
    if (approvedModelId) {
      if (conversation.grillingRoundId) {
        throw new UnprocessableEntityException(
          "A Grilling Conversation's questions come from the server, so it has no model to pick",
        );
      }
      await this.models.assertPickable(approvedModelId);
    }
    return this.exclusively(id, async () => {
      if (conversation.grillingRoundId) await this.grilling.assertCanWrite(user, id);
      await this.db.$transaction(async (tx) => {
        const position = await nextPosition(tx, id);
        await tx.conversationMessage.create({
          data: { conversationId: id, position, role: 'USER', content },
        });
        await tx.conversation.update({
          where: { id },
          data: { updatedAt: new Date(), ...(approvedModelId ? { modelId: approvedModelId } : {}) },
        });
      });
      return toTurnView(await this.turn(user, conversation, id));
    });
  }

  /**
   * Asks the AI again for a reply to the last message, after a failed one. When
   * the failure came after a round of tool calls, that round stays and the AI
   * goes on from its results.
   */
  async retry(user: User, id: string): Promise<ConversationTurnView> {
    const conversation = await this.ownedWithAccess(user, id);
    return this.exclusively(id, async () => {
      const last = await this.db.conversationMessage.findFirst({
        where: { conversationId: id },
        orderBy: { position: 'desc' },
        select: { role: true },
      });
      if (last?.role !== 'USER' && last?.role !== 'TOOL') {
        throw new ConflictException('Nothing to retry: the last message already has its reply');
      }
      if (conversation.grillingRoundId) await this.grilling.assertCanWrite(user, id);
      return toTurnView(await this.turn(user, conversation, id));
    });
  }

  /**
   * Stops the reply being written in the owner's Conversation (ticket 0046).
   * The text written so far is kept as the reply, and tool calls it had not
   * finished are dropped; the request that asked for the reply answers as usual.
   * 409 when nothing is being written (a Grilling Conversation's turns are
   * written by the server, so they are never stopped).
   */
  async stop(user: User, id: string): Promise<StopConversationResult> {
    await this.owned(user, id);
    const reply = this.replying.get(id);
    if (!reply || reply.signal.aborted) {
      throw new ConflictException('No reply is being written in this Conversation');
    }
    reply.abort();
    return { stopped: true };
  }

  async delete(user: User, id: string): Promise<void> {
    const { count } = await this.db.conversation.deleteMany({ where: { id, ownerId: user.id } });
    if (!count) throw notFound();
  }

  // ─── A turn ────────────────────────────────────────────────────────────────

  /** A Grilling Conversation's turn, or else the AI's reply. */
  private async turn(user: User, conversation: ConversationWithScope, id: string): Promise<Turn> {
    if (!conversation.grillingRoundId) return this.reply(user, id);
    const turn: GrillingTurn = await this.grilling.reply(user, id);
    return {
      conversation: toConversationListItem(turn.conversation),
      message: turn.message,
      steps: [],
      reply: turn.reply,
      actionCards: [],
    };
  }

  /**
   * Replies to the trailing message: compacts the history if needed, retrieves
   * the scope's context, then streams the AI's reply to the
   * owner. Each round of tool calls is run and stored, and the AI goes on with
   * the results; the final reply is stored once complete. Call only while
   * holding the Conversation's lock.
   */
  private async reply(user: User, id: string): Promise<Turn> {
    const stop = new AbortController();
    this.replying.set(id, stop);
    try {
      return await this.replyUntil(user, id, stop.signal);
    } finally {
      this.replying.delete(id);
    }
  }

  /** The reply, until `stopped` aborts: then what was written so far is the reply. */
  private async replyUntil(user: User, id: string, stopped: AbortSignal): Promise<Turn> {
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
    const model = await this.modelFor(conversation);
    const recordedModel = toRecordedModelColumns(model.record);
    const tools = this.cards.toolsFor(conversation);
    // Every share of this turn comes from its model's window (0060).
    const { budget } = await this.budgets.forTask(
      'chat',
      conversation.featureId ? 'conversationFeature' : 'conversationProject',
      { model: model.choice, tools },
    );
    const compacting = { user, scope, budget, model: model.choice };
    let { summary, recent } = await this.compact(conversation, rows, compacting);
    const { context, foundation } = await this.contextFor(conversation, recent, budget);

    let recentMessages = forAi(recent, budget.history - estimateTokens(summary));
    let retried = false;
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
        const stream = this.ai.chat(
          {
            scope,
            context,
            foundation,
            summary,
            recentMessages: [...recentMessages],
            tools: offered,
            signal: stopped,
          },
          { model: model.choice },
        );
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
        if (stopped.aborted)
          return this.finish(user, id, replyId, text, message, steps, actionCards, model);
        if (error instanceof ContextTooLongError && !retried) {
          // Too long for the model after all: compact at once, then try this step once more.
          retried = true;
          this.logger.warn('The request was too long for the model; compacting and retrying');
          const current = await this.db.conversation.findUniqueOrThrow({ where: { id } });
          const since = await this.db.conversationMessage.findMany({
            where: { conversationId: id, position: { gte: current.summarizedThrough } },
            orderBy: { position: 'asc' },
          });
          ({ summary, recent } = await this.compact(current, since, {
            ...compacting,
            force: true,
          }));
          recentMessages = forAi(recent, budget.history - estimateTokens(summary));
          round--;
          continue;
        }
        this.logger.error('A Conversation reply failed', error as Error);
        const reason = 'The AI failed while replying, so no reply was saved. Try again.';
        emit({
          event: 'conversation.failed',
          data: { conversationId: id, messageId: replyId, message: reason },
        });
        throw replyFailed(id, reason);
      }

      // Stopped, or nothing more to do: the text is the reply. A stopped step's calls never run.
      if (!toolCalls.length || stopped.aborted) {
        return this.finish(user, id, replyId, text, message, steps, actionCards, model);
      }

      // A round of tool calls: store the calls, then run each and store its result.
      const step = await this.store(id, {
        id: replyId,
        role: 'ASSISTANT',
        content: text,
        toolCalls: toolCalls as Prisma.InputJsonValue,
        ...recordedModel,
      });
      const results: MessageRow[] = [];
      const made: ActionCardView[] = [];
      for (const call of toolCalls) {
        const run = await this.cards.run(user, conversation, step.message.id, call, model);
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
      // The turn's own tool rounds come out of the reply's room, as they are written.
      recentMessages = [...recentMessages, ...[step.message, ...results].map(toChatMessage)];
    }
  }

  /** Stores the turn's final reply and tells the owner it is done. */
  private async finish(
    user: User,
    id: string,
    replyId: string,
    text: string,
    message: MessageRow,
    steps: MessageRow[],
    actionCards: ActionCardView[],
    model: TurnModel,
  ): Promise<Turn> {
    const saved = await this.store(id, {
      id: replyId,
      role: 'ASSISTANT',
      content: text,
      ...toRecordedModelColumns(model.record),
      modelNotice: model.notice,
    });
    this.bus.emit(user.id, {
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
   * The model of this turn: the one picked in the Conversation, else the chat
   * default (precedence as in AiSettingsService.chooseModel). When the model the
   * Conversation last ran on was removed, and nobody picked another since, the
   * reply says which one it used instead. Removing a model clears `modelId`, so the
   * last reply's record tells what was there; once a reply records the fallback,
   * the notice isn't given again.
   */
  private async modelFor(conversation: { id: string; modelId: string | null }): Promise<TurnModel> {
    const choice = await this.models.chooseModel('chat', conversation.modelId ?? undefined);
    const record = await this.models.record(choice);
    let notice: string | null = null;
    if (!conversation.modelId) {
      const last = await this.db.conversationMessage.findFirst({
        where: { conversationId: conversation.id, role: 'ASSISTANT', modelName: { not: null } },
        orderBy: { position: 'desc' },
        select: { approvedModelId: true, modelDisplayName: true, modelName: true },
      });
      const before = fromRecordedModelColumns(last);
      if (
        before?.approvedModelId &&
        before.approvedModelId !== choice.approvedModelId &&
        !(await this.models.exists(before.approvedModelId))
      ) {
        notice = `${modelLabel(before)} was removed, so this reply used ${modelLabel(record)}.`;
      }
    }
    return { choice, record, notice };
  }

  /**
   * The Conversation Summary and the messages to send this turn (ticket 0060).
   * The history (the summary so far and the messages after it) is counted once
   * on the turn's model; past `compaction.at` of its share, every message before
   * the newest turns that fit in `compaction.keep` of it (the current turn always
   * stays) is folded into the summary, which is cut to `compaction.summary` of
   * it and saved before the reply, so a failed reply never folds them twice.
   * `force` (the provider said "too long") folds everything before the current
   * turn without counting.
   */
  private async compact(
    conversation: { id: string; summary: string; summarizedThrough: number },
    rows: MessageRow[],
    turn: {
      user: User;
      scope: ConversationScopeForAi;
      budget: Budget;
      model: ModelChoice;
      force?: boolean;
    },
  ): Promise<{ summary: string; recent: MessageRow[] }> {
    const { at, keep, summary: summaryShare } = BUDGET_CONFIG.compaction;
    const share = turn.budget.history;
    const unchanged = { summary: conversation.summary, recent: rows };
    // The current turn starts at the person's last message; it is never folded.
    const current = rows.findLastIndex((m) => m.role === 'USER');
    if (current <= 0) return unchanged;

    // The provider's count over the script-aware estimate: scales each message's estimate.
    let scale = 1;
    if (!turn.force) {
      const messages = rows.map(toChatMessage);
      const counted = await this.ai.countTokens(
        { system: conversation.summary, messages },
        { model: turn.model },
      );
      if (counted <= at * share) return unchanged;
      const estimated =
        estimateTokens(conversation.summary) +
        messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      scale = Math.max(0.25, counted / Math.max(1, estimated));
    }

    // Keep the newest whole turns word for word while they fit in `keep` of the share.
    let start = current;
    if (!turn.force) {
      const cost = (m: MessageRow) => estimateMessageTokens(toChatMessage(m)) * scale;
      let kept = rows.slice(current).reduce((sum, m) => sum + cost(m), 0);
      for (let i = current - 1; i >= 0; i--) {
        kept += cost(rows[i] as MessageRow);
        if (kept > keep * share) break;
        if (rows[i]?.role === 'USER') start = i;
      }
    }
    if (start === 0) return unchanged;
    const older = rows.slice(0, start);
    const recent = rows.slice(start);

    let summary: string;
    try {
      const cards = await this.cards.forConversation(turn.user, conversation.id);
      const folded = await this.ai.summarizeConversation({
        scope: turn.scope,
        summary: conversation.summary,
        messages: older.map(toChatMessage),
        actionCards: cards.map((c) => ({ kind: c.kind, title: c.title, status: c.status })),
      });
      summary = clipToTokens(
        renderConversationSummary(folded),
        Math.max(200, Math.floor(summaryShare * share)),
      );
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
   * newest messages, within the turn's budget: a Feature gets its own Spec,
   * Decisions and Attachments first (with the Brief and the Guidelines in the
   * foundation's share), a Project its Brief, Features and Project Attachments.
   */
  private async contextFor(
    conversation: { projectId: string; featureId: string | null },
    recent: MessageRow[],
    budget: Budget,
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
        budget,
      );
      const context = await this.retriever.forFeature(conversation.featureId, query, contextBudget);
      return { context: withoutBrief(context), foundation };
    }
    const [blocks, criteria] = await Promise.all([
      this.retriever.forProject(conversation.projectId, query, projectBudget(budget)),
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
  private exclusively<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.locks.exclusively(id, work);
  }
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

/**
 * The messages as the AI gets them, within `room` tokens (the history's share
 * less the summary). Compaction keeps the current turn whole, so only a very
 * long message (one long paste on a small model) can still overflow: the
 * longest messages are then shortened, for the AI only; the stored ones stay whole.
 */
function forAi(rows: MessageRow[], room: number): ChatMessageForAi[] {
  const messages = rows.map(toChatMessage);
  const costs = messages.map(estimateMessageTokens);
  let over = costs.reduce((a, b) => a + b, 0) - Math.max(0, room);
  while (over > 0) {
    const longest = costs.indexOf(Math.max(...costs));
    const m = messages[longest];
    const cost = costs[longest] ?? 0;
    if (!m || cost <= MIN_SENT_MESSAGE_TOKENS) break;
    const target = Math.max(MIN_SENT_MESSAGE_TOKENS, cost - over);
    const clipped = { ...m, content: clipToTokens(m.content, target - MESSAGE_OVERHEAD_TOKENS) };
    messages[longest] = clipped;
    costs[longest] = estimateMessageTokens(clipped);
    over -= cost - (costs[longest] ?? 0);
  }
  return messages;
}

/** A message is never shortened below this many tokens for the AI. */
const MIN_SENT_MESSAGE_TOKENS = 100;

function toTurnView(turn: Turn): ConversationTurnView {
  return {
    conversation: turn.conversation,
    message: toConversationMessageView(turn.message) satisfies ConversationMessageView,
    steps: turn.steps.map(toConversationMessageView),
    reply: toConversationMessageView(turn.reply),
    actionCards: turn.actionCards,
  };
}
