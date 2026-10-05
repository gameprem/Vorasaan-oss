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
  type CompactConversationInput,
  type CompactConversationResult,
  type ConversationCompactionSummary,
  type ConversationCompactionTrigger,
  type ConversationCompactionView,
  type ConversationList,
  type ConversationListItem,
  type ConversationMessagePage,
  type ConversationMessageView,
  type ConversationScopeInput,
  type ConversationTurnView,
  type ConversationUsage,
  type ConversationView,
  type GetConversationQuery,
  type ListConversationMessagesQuery,
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
  type PlatformForAi,
  type ProjectFoundationForAi,
  type RecordForAi,
} from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { BUDGET_CONFIG, type Budget, ContextBudgets, projectBudget } from '../ai/context-budget.ts';
import { personLanguage } from '../ai/language.ts';
import {
  parseConversationSummary,
  renderConversationSummary,
  SUMMARY_SECTIONS,
} from '../ai/prompts.ts';
import {
  fromRecordedModelColumns,
  modelLabel,
  toRecordedModelColumns,
} from '../ai/recorded-model.ts';
import {
  estimateChatTokens,
  estimateMessageTokens,
  MESSAGE_OVERHEAD_TOKENS,
} from '../ai/token-count.ts';
import { projectAccess } from '../brief/brief-access.ts';
import { CoverageService } from '../coverage/coverage.service.ts';
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
  type CompactionRow,
  type ConversationWithScope,
  compactionInclude,
  conversationInclude,
  toCompactionView,
  toConversationListItem,
  toConversationMessageView,
  toConversationView,
} from './conversation.view.ts';
import { conversationNotFound as notFound, replyFailed } from './conversation-errors.ts';
import { ConversationLocks } from './conversation-locks.ts';
import { loadMessagePage } from './message-pages.ts';

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
  /** How full the Conversation is after the turn (0066); null in a Grilling Conversation. */
  usage: ConversationUsage | null;
};
/** The provider's usage of a turn's steps, summed (0061, 0066); null where it said nothing. */
type StepUsage = { inputTokens: number | null; cacheReadTokens: number | null };
const NO_USAGE: StepUsage = { inputTokens: null, cacheReadTokens: null };
/**
 * What the context meter of a turn needs (ticket 0066): its model and plan, the
 * provider's count over the estimate (1 when the turn didn't count), and the
 * provider's usage of the turn's steps.
 */
type Meter = { model: TurnModel; budget: Budget; scale: number; usage: StepUsage };
/** What a fold records besides its summary: why it happened, who asked, and what to keep. */
type FoldRecord = {
  trigger: ConversationCompactionTrigger;
  focus?: string | null;
  createdById?: string | null;
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
    private readonly coverage: CoverageService,
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

  /**
   * The Conversation with its latest page of messages, or the page `around` a
   * message (a deep link; ticket 0066), and all its Action Cards and compactions.
   */
  async get(user: User, id: string, query: GetConversationQuery = {}): Promise<ConversationView> {
    const conversation = await this.owned(user, id);
    const page = await loadMessagePage(this.db, id, query);
    const actionCards = await this.cards.forConversation(user, id);
    const compactions = await this.compactionViews(
      id,
      await this.db.conversationCompaction.findMany({
        where: { conversationId: id },
        orderBy: { number: 'asc' },
        include: compactionInclude,
      }),
    );
    const progress = conversation.grillingRoundId ? await this.grilling.progress(id) : null;
    return toConversationView(conversation, page, actionCards, compactions, progress);
  }

  /** `GET /conversations/:id/messages`: one page of the owner's messages (ticket 0066). */
  async messages(
    user: User,
    id: string,
    query: ListConversationMessagesQuery,
  ): Promise<ConversationMessagePage> {
    await this.owned(user, id);
    const page = await loadMessagePage(this.db, id, query);
    return { ...page, messages: page.messages.map(toConversationMessageView) };
  }

  /**
   * How full the Conversation is (ticket 0066): for the model its next reply runs
   * on, or for `approvedModelId` (the model picker; 422 unless approved), which
   * stays a question only: the Conversation keeps its model until a message is
   * sent with the new one. The history is counted on that model, once.
   */
  async usage(user: User, id: string, approvedModelId?: string): Promise<ConversationUsage> {
    const conversation = await this.owned(user, id);
    if (conversation.grillingRoundId) {
      throw new UnprocessableEntityException(
        "A Grilling Conversation's questions come from the server, so it has no context to meter",
      );
    }
    if (approvedModelId) await this.models.assertPickable(approvedModelId);
    const choice = await this.models.chooseModel(
      'chat',
      approvedModelId ?? conversation.modelId ?? undefined,
    );
    const record = await this.models.record(choice);
    const budget = await this.planFor(conversation, choice);
    const { summary, messages } = await this.history(id);
    const used =
      summary || messages.length
        ? await this.ai.countTokens({ system: summary, messages }, { model: choice })
        : 0;
    return toUsage(conversation, record, budget, used);
  }

  /**
   * "View summary" (ticket 0066): the Conversation Summary as one compaction left
   * it, in its sections. Read-only (see ConversationCompactionSummary).
   */
  async compactionSummary(
    user: User,
    id: string,
    compactionId: string,
  ): Promise<ConversationCompactionSummary> {
    await this.owned(user, id);
    const row = await this.db.conversationCompaction.findFirst({
      where: { id: compactionId, conversationId: id },
      include: compactionInclude,
    });
    if (!row) throw new NotFoundException('Compaction not found');
    const [view] = await this.compactionViews(id, [row]);
    const latest = await this.db.conversationCompaction.findFirst({
      where: { conversationId: id },
      orderBy: { number: 'desc' },
      select: { id: true },
    });
    const draft = parseConversationSummary(row.summary);
    const sections = SUMMARY_SECTIONS.map(([key, heading]) => {
      const value = draft[key];
      const items = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
      return { heading, items };
    });
    return {
      ...(view as ConversationCompactionView),
      summary: row.summary,
      sections,
      current: latest?.id === row.id,
    };
  }

  /**
   * Compacts now (ticket 0066): "Compact now" in the context meter, or `/compact
   * [focus]`. Everything before the last turn is folded into the Conversation
   * Summary, which keeps `focus` in full; the last turn stays word for word.
   *
   * Unless `skipRecordCheck`, the fold is first checked against the Spec (a
   * Feature Conversation) or the Project Brief: when something agreed isn't
   * recorded there yet, the AI offers an Action Card that records it, and nothing
   * is folded (RECORD_FIRST). The person approves, declines or skips it, then
   * compacts again with `skipRecordCheck`. Someone who may not propose a change
   * there gets no card, and the fold goes on.
   *
   * 409 with nothing to fold (one turn so far); 422 in a Grilling Conversation.
   */
  async compactNow(
    user: User,
    id: string,
    input: CompactConversationInput,
  ): Promise<CompactConversationResult> {
    const conversation = await this.ownedWithAccess(user, id);
    if (conversation.grillingRoundId) {
      throw new UnprocessableEntityException(
        'A Grilling Conversation keeps its questions and answers whole, so it is never compacted',
      );
    }
    const focus = input.focus?.trim() || null;
    return this.exclusively(id, async () => {
      const current = await this.db.conversation.findUniqueOrThrow({
        where: { id },
        include: {
          ...conversationInclude,
          feature: { select: { id: true, title: true, description: true } },
        },
      });
      const rows = await this.db.conversationMessage.findMany({
        where: { conversationId: id, position: { gte: current.summarizedThrough } },
        orderBy: { position: 'asc' },
      });
      const last = rows.findLastIndex((m) => m.role === 'USER');
      if (last <= 0) {
        throw new ConflictException(
          'Nothing to compact yet: only the latest turn comes after the last summary',
        );
      }
      const older = rows.slice(0, last);
      const recent = rows.slice(last);
      const model = await this.modelFor(current);
      const budget = await this.planFor(current, model.choice);
      const record = input.skipRecordCheck ? null : await this.recordFor(current);
      const folded = await this.summarize(user, current, older, {
        scope: scopeForAi(current),
        budget,
        focus,
        record,
      });

      if (record && folded.unrecorded.length) {
        const offer = await this.offerRecord(user, current, record, folded.unrecorded, model);
        if (offer) return { status: 'RECORD_FIRST', unrecorded: folded.unrecorded, ...offer };
      }

      const compaction = await this.saveFold(user, current, folded.summary, recent, {
        trigger: 'MANUAL',
        focus,
        createdById: user.id,
      });
      const after = await this.db.conversation.findUniqueOrThrow({
        where: { id },
        include: conversationInclude,
      });
      const usage = await this.usageAfter(after, { model, budget, scale: null, usage: NO_USAGE });
      this.bus.emit(user.id, { event: 'conversation.usage', data: { conversationId: id, usage } });
      return {
        status: 'COMPACTED',
        conversation: toConversationListItem(after),
        compaction,
        usage,
      };
    });
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
      usage: null,
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
    let { summary, recent, scale } = await this.compact(conversation, rows, compacting);
    const { context, foundation, missingSections } = await this.contextFor(
      conversation,
      recent,
      budget,
    );

    let recentMessages = forAi(recent, budget.history - estimateTokens(summary));
    let retried = false;
    const steps: MessageRow[] = [];
    const actionCards: ActionCardView[] = [];
    const emit = (event: ServerEvent) => this.bus.emit(user.id, event);
    const meter: Meter = { model, budget, scale, usage: { ...NO_USAGE } };
    const language = await personLanguage(this.db, user.id);
    const finish = (replyId: string, text: string) =>
      this.finish(user, id, replyId, text, message, steps, actionCards, meter);

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
            ...(missingSections?.length ? { missingSections } : {}),
            signal: stopped,
          },
          {
            model: model.choice,
            language,
            receipt: {
              requestedById: user.id,
              output: { kind: 'CONVERSATION_MESSAGE', id: replyId },
              projectId: conversation.projectId,
            },
          },
        );
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            if (!chunk.delta) continue;
            text += chunk.delta;
            emit({
              event: 'conversation.delta',
              data: { conversationId: id, messageId: replyId, delta: chunk.delta },
            });
          } else if (chunk.type === 'usage') {
            meter.usage = addUsage(meter.usage, chunk.usage);
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
        if (stopped.aborted) return finish(replyId, text);
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
          // The count before the fold stays this turn's scale; the meter needs no new count.
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
      if (!toolCalls.length || stopped.aborted) return finish(replyId, text);

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

  /**
   * Stores the turn's final reply and the provider's usage of the turn, tells the
   * owner it is done, then how full the Conversation is now (ticket 0066).
   */
  private async finish(
    user: User,
    id: string,
    replyId: string,
    text: string,
    message: MessageRow,
    steps: MessageRow[],
    actionCards: ActionCardView[],
    meter: Meter,
  ): Promise<Turn> {
    const { model } = meter;
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
    const conversation = await this.db.conversation.update({
      where: { id },
      data: {
        lastInputTokens: meter.usage.inputTokens,
        lastCacheReadTokens: meter.usage.cacheReadTokens,
      },
      include: conversationInclude,
    });
    const usage = await this.usageAfter(conversation, meter);
    this.bus.emit(user.id, { event: 'conversation.usage', data: { conversationId: id, usage } });
    return {
      conversation: toConversationListItem(conversation),
      message,
      steps,
      reply: saved.message,
      actionCards,
      usage,
    };
  }

  // ─── The context meter (ticket 0066) ───────────────────────────────────────

  /** A turn's plan on `choice`: the same call the turn itself makes (0060). */
  private async planFor(
    conversation: { featureId: string | null },
    choice: ModelChoice,
  ): Promise<Budget> {
    const { budget } = await this.budgets.forTask(
      'chat',
      conversation.featureId ? 'conversationFeature' : 'conversationProject',
      { model: choice, tools: this.cards.toolsFor(conversation) },
    );
    return budget;
  }

  /** The history the next turn sends: the Conversation Summary and the messages after it. */
  private async history(id: string): Promise<{ summary: string; messages: ChatMessageForAi[] }> {
    const conversation = await this.db.conversation.findUniqueOrThrow({
      where: { id },
      select: { summary: true, summarizedThrough: true },
    });
    const rows = await this.db.conversationMessage.findMany({
      where: { conversationId: id, position: { gte: conversation.summarizedThrough } },
      orderBy: { position: 'asc' },
    });
    return { summary: conversation.summary, messages: rows.map(toChatMessage) };
  }

  /**
   * How full the Conversation is after a turn or a fold. A turn doesn't count again
   * (0060 counts once per turn): its own count scales the estimate. Without a scale
   * (a fold by hand) the history is counted on the model.
   */
  private async usageAfter(
    conversation: ConversationWithScope,
    meter: Omit<Meter, 'scale'> & { scale: number | null },
  ): Promise<ConversationUsage> {
    const { summary, messages } = await this.history(conversation.id);
    const used =
      meter.scale === null
        ? await this.ai.countTokens({ system: summary, messages }, { model: meter.model.choice })
        : Math.ceil(estimateChatTokens({ system: summary, messages }) * meter.scale);
    return toUsage(conversation, meter.model.record, meter.budget, used);
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
    conversation: { id: string; summary: string; summarizedThrough: number; projectId: string },
    rows: MessageRow[],
    turn: {
      user: User;
      scope: ConversationScopeForAi;
      budget: Budget;
      model: ModelChoice;
      force?: boolean;
    },
  ): Promise<{ summary: string; recent: MessageRow[]; scale: number }> {
    const { at, keep } = BUDGET_CONFIG.compaction;
    const share = turn.budget.history;
    // The current turn starts at the person's last message; it is never folded.
    const current = rows.findLastIndex((m) => m.role === 'USER');
    if (current <= 0) return { summary: conversation.summary, recent: rows, scale: 1 };

    // The provider's count over the script-aware estimate: scales each message's estimate.
    let scale = 1;
    if (!turn.force) {
      const messages = rows.map(toChatMessage);
      const counted = await this.ai.countTokens(
        { system: conversation.summary, messages },
        { model: turn.model },
      );
      const estimated = estimateChatTokens({ system: conversation.summary, messages });
      scale = Math.max(0.25, counted / Math.max(1, estimated));
      if (counted <= at * share) return { summary: conversation.summary, recent: rows, scale };
    }
    const unchanged = { summary: conversation.summary, recent: rows, scale };

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

    const { summary } = await this.summarize(turn.user, conversation, older, turn);
    await this.saveFold(turn.user, conversation, summary, recent, {
      trigger: turn.force ? 'TOO_LONG' : 'AUTO',
    });
    return { summary, recent, scale };
  }

  /**
   * The Conversation Summary with `older` folded in, cut to `compaction.summary`
   * of the history's share; and, when given a Spec or Brief to check against, the
   * agreed points it doesn't record yet. A failing summarizer is a 502.
   */
  private async summarize(
    user: User,
    conversation: { id: string; summary: string; projectId: string },
    older: MessageRow[],
    turn: {
      scope: ConversationScopeForAi;
      budget: Budget;
      focus?: string | null;
      record?: RecordForAi | null;
    },
  ): Promise<{ summary: string; unrecorded: string[] }> {
    try {
      const cards = await this.cards.forConversation(user, conversation.id);
      const folded = await this.ai.summarizeConversation(
        {
          scope: turn.scope,
          summary: conversation.summary,
          messages: older.map(toChatMessage),
          actionCards: cards.map((c) => ({ kind: c.kind, title: c.title, status: c.status })),
          ...(turn.focus ? { focus: turn.focus } : {}),
          ...(turn.record ? { record: turn.record } : {}),
        },
        {
          language: await personLanguage(this.db, user.id),
          receipt: {
            requestedById: user.id,
            output: { kind: 'CONVERSATION', id: conversation.id },
            projectId: conversation.projectId,
          },
        },
      );
      const room = Math.max(
        200,
        Math.floor(BUDGET_CONFIG.compaction.summary * turn.budget.history),
      );
      return {
        summary: clipToTokens(renderConversationSummary(folded), room),
        unrecorded: folded.unrecorded ?? [],
      };
    } catch (error) {
      this.logger.error('Folding a Conversation into its summary failed', error as Error);
      throw replyFailed(
        conversation.id,
        'The AI failed while summarizing earlier messages, so nothing was saved. Try again.',
      );
    }
  }

  /**
   * Saves a fold: the Conversation's summary and where it now starts, and a
   * compaction (ticket 0066) holding the summary as it is now, so its divider can
   * show it later. The owner is told (`conversation.compacted`).
   */
  private async saveFold(
    user: User,
    conversation: { id: string; summarizedThrough: number },
    summary: string,
    recent: MessageRow[],
    record: FoldRecord,
  ): Promise<ConversationCompactionView> {
    const through = recent[0]?.position ?? conversation.summarizedThrough;
    const row = await this.db.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { summary, summarizedThrough: through },
      });
      const { _max } = await tx.conversationCompaction.aggregate({
        where: { conversationId: conversation.id },
        _max: { number: true },
      });
      return tx.conversationCompaction.create({
        data: {
          conversationId: conversation.id,
          number: (_max.number ?? 0) + 1,
          trigger: record.trigger,
          focus: record.focus ?? null,
          createdById: record.createdById ?? null,
          summarizedThrough: through,
          summary,
        },
        include: compactionInclude,
      });
    });
    const compaction = toCompactionView(row, recent[0]?.id ?? null);
    this.bus.emit(user.id, {
      event: 'conversation.compacted',
      data: { conversationId: conversation.id, compaction, summarizedThrough: through },
    });
    return compaction;
  }

  /** Compactions as views, each with the message its divider goes above. */
  private async compactionViews(
    conversationId: string,
    rows: CompactionRow[],
  ): Promise<ConversationCompactionView[]> {
    if (!rows.length) return [];
    const firsts = await this.db.conversationMessage.findMany({
      where: { conversationId, position: { in: rows.map((r) => r.summarizedThrough) } },
      select: { id: true, position: true },
    });
    const byPosition = new Map(firsts.map((m) => [m.position, m.id]));
    return rows.map((r) => toCompactionView(r, byPosition.get(r.summarizedThrough) ?? null));
  }

  /** What a fold checks agreed points against: the Feature's Spec, else the Project Brief. */
  private async recordFor(conversation: {
    projectId: string;
    featureId: string | null;
  }): Promise<RecordForAi> {
    if (conversation.featureId) {
      const spec = await this.db.specVersion.findFirst({
        where: { featureId: conversation.featureId },
        orderBy: { version: 'desc' },
        select: { markdown: true },
      });
      return { kind: 'SPEC', markdown: spec?.markdown ?? '' };
    }
    const brief = await this.db.briefVersion.findFirst({
      where: { projectId: conversation.projectId },
      orderBy: { version: 'desc' },
      select: { markdown: true },
    });
    return { kind: 'BRIEF', markdown: brief?.markdown ?? '' };
  }

  /**
   * Before a fold by hand (ticket 0066, closing 0060's open point): the AI's
   * message that lists the agreed points not recorded yet, and the Spec or Brief
   * Proposal that adds them, as an Action Card under it. The proposal adds them
   * as a section at the end; the person approves it, declines it, or asks for
   * changes (a Redraft, 0065) to work them in elsewhere. Null when no card could
   * be made (the person may not propose a change there): then nothing is kept.
   */
  private async offerRecord(
    user: User,
    conversation: ConversationWithScope,
    record: RecordForAi,
    points: string[],
    model: TurnModel,
  ): Promise<{ messages: ConversationMessageView[]; card: ActionCardView } | null> {
    const name = record.kind === 'SPEC' ? 'Spec' : 'Project Brief';
    const list = points.map((p) => `- ${p}`).join('\n');
    const call: ChatToolCall = {
      id: `record-${randomUUID()}`,
      name: record.kind === 'SPEC' ? 'draftSpecProposal' : 'draftBriefProposal',
      args: {
        proposedMarkdown:
          `${record.markdown.trimEnd()}\n\n## Agreed in a Conversation\n\n${list}\n`.trimStart(),
        summary: `Record what was agreed in "${conversation.title}"`.slice(0, 300),
      },
    };
    const step = await this.store(conversation.id, {
      role: 'ASSISTANT',
      content:
        `Before I compact this Conversation: we agreed on these, but the ${name} doesn't record them yet.\n\n${list}\n\n` +
        `I drafted a change to the ${name} that adds them. Approve it, decline it, or skip it, and compaction goes on.`,
      toolCalls: [call] as Prisma.InputJsonValue,
    });
    const run = await this.cards.run(user, conversation, step.message.id, call, model);
    const card = run.cards[0];
    if (!card) {
      await this.db.conversationMessage.delete({ where: { id: step.message.id } });
      return null;
    }
    const result = await this.store(conversation.id, {
      role: 'TOOL',
      content: run.content,
      toolCallId: call.id,
    });
    const messages = [step.message, result.message].map(toConversationMessageView);
    this.bus.emit(user.id, {
      event: 'conversation.step',
      data: { conversationId: conversation.id, messages },
    });
    this.bus.emit(user.id, {
      event: 'conversation.actionCard.created',
      data: { conversationId: conversation.id, card },
    });
    return { messages, card };
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
  ): Promise<{
    context: ContextBlock[];
    foundation: ProjectFoundationForAi;
    missingSections?: PlatformForAi[];
  }> {
    // The person's newest messages, before any tool round of the turn being replied to.
    const trailing: string[] = [];
    let i = recent.length - 1;
    while (i >= 0 && recent[i]?.role !== 'USER') i--;
    for (; i >= 0 && recent[i]?.role === 'USER'; i--) trailing.unshift(recent[i]?.content ?? '');
    const query = trailing.join('\n\n');
    if (conversation.featureId) {
      // Its target Platforms the Spec has no section for (ticket 0052), read alongside.
      const [{ foundation, contextBudget }, missingSections] = await Promise.all([
        this.foundation.forFeature(conversation.featureId, budget),
        this.coverage.missingSectionsOfLatest(conversation.featureId),
      ]);
      const context = await this.retriever.forFeature(
        conversation.featureId,
        query,
        contextBudget,
        {
          k: budget.topK,
        },
      );
      return { context: withoutBrief(context), foundation, missingSections };
    }
    const [blocks, criteria] = await Promise.all([
      this.retriever.forProject(conversation.projectId, query, projectBudget(budget), {
        k: budget.topK,
      }),
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
    usage: turn.usage,
  };
}

/** One step's usage added to the turn's: a number the provider gave counts, null adds nothing. */
function addUsage(total: StepUsage, step: StepUsage): StepUsage {
  const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
  return {
    inputTokens: add(total.inputTokens, step.inputTokens),
    cacheReadTokens: add(total.cacheReadTokens, step.cacheReadTokens),
  };
}

/** The context meter's numbers (ticket 0066): the plan of `budget`, and `used` of the history. */
function toUsage(
  conversation: { id: string; lastInputTokens: number | null; lastCacheReadTokens: number | null },
  model: RecordedModel,
  budget: Budget,
  used: number,
): ConversationUsage {
  const share = budget.history;
  const { at, warn } = BUDGET_CONFIG.compaction;
  const { lastInputTokens, lastCacheReadTokens } = conversation;
  return {
    conversationId: conversation.id,
    model,
    contextWindow: budget.window,
    plan: {
      system: budget.system,
      foundation: budget.foundation,
      context: budget.context,
      history: budget.history,
      reply: budget.reply,
    },
    history: {
      used,
      share,
      compactAt: Math.floor(at * share),
      warnAt: Math.floor(warn * share),
      fraction: share > 0 ? used / share : 0,
    },
    lastTurn:
      lastInputTokens === null && lastCacheReadTokens === null
        ? null
        : { inputTokens: lastInputTokens, cacheReadTokens: lastCacheReadTokens },
  };
}
