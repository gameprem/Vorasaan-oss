import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  GRILLING_ROUNDS,
  type GrillingConversationProgress,
  type GrillingFollowUp,
  type GrillingNote,
  isGrillingSkip,
  MAX_GRILLING_FOLLOW_UPS,
  type ServerEvent,
} from '@vorasaan/shared';
import { AI_PORT, type AiPort } from '../ai/ai.port.ts';
import { personLanguage } from '../ai/language.ts';
import { projectAccess } from '../brief/brief-access.ts';
import {
  type ConversationWithScope,
  conversationInclude,
  toConversationMessageView,
} from '../conversations/conversation.view.ts';
import { replyFailed } from '../conversations/conversation-errors.ts';
import { ConversationLocks } from '../conversations/conversation-locks.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { GrillingService } from './grilling.service.ts';
import { followUpsOf } from './grilling.view.ts';
import {
  answeredElsewhere,
  ask,
  asking,
  closedText,
  type GrillingConversationState,
  isOpen,
  nextQuestion,
  noteMessage,
  openGrillingConversations,
  recorded,
  skippedText,
  stateOf,
  toStateJson,
  waiting,
} from './grilling-conversation.ts';

type MessageRow = Prisma.ConversationMessageGetPayload<object>;

const stateInclude = {
  grillingRound: {
    include: {
      grilling: { select: { id: true, status: true, projectId: true, project: true } },
      questions: {
        orderBy: { position: 'asc' },
        include: { answeredBy: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.ConversationInclude;

type GrillingConv = Prisma.ConversationGetPayload<{ include: typeof stateInclude }>;
type AskedRound = NonNullable<GrillingConv['grillingRound']>;
type AskedQuestion = AskedRound['questions'][number];

/** One turn of a Grilling Conversation: the owner's message and the server's reply. */
export type GrillingTurn = {
  conversation: ConversationWithScope;
  message: MessageRow;
  reply: MessageRow;
};

/**
 * Grilling Conversations (ticket 0044, ADR 0008): when a round starts, each
 * person holding its Team Role gets their own Conversation, where the round's
 * questions are asked one at a time. After each answer the AI may ask a
 * follow-up, at most MAX_GRILLING_FOLLOW_UPS per question (counted here, not
 * left to the AI). "skip" skips the question, or ends its follow-ups.
 *
 * The answer and its follow-ups are recorded through GrillingService.answer,
 * the same as `POST /grillings/:id/questions/:questionId/answer`, so a round
 * still ends when every question has an answer from a holder of its role, and
 * the answer that completes it moves the Grilling on under the same lock and
 * revision check. Whichever way a question is answered, the other holders'
 * Conversations are told (`conversation.appended`) and don't ask it again.
 *
 * Only the owner reads or writes their Grilling Conversation, as with any
 * Conversation; ConversationsService routes their messages here.
 */
@Injectable()
export class GrillingConversationsService {
  private readonly logger = new Logger(GrillingConversationsService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly grilling: GrillingService,
    private readonly locks: ConversationLocks,
    private readonly bus: EventBus,
  ) {
    grilling.onRoundsChanged((roundIds) => this.sync(roundIds));
  }

  /**
   * `POST /grillings/:id/conversation`: my Grilling Conversation for the round
   * being asked, opened now if I have none (I joined the Team after the round
   * started, or deleted mine). Only holders of the round's Team Role.
   */
  async open(user: User, grillingId: string): Promise<string> {
    const g = await this.db.grilling.findUnique({
      where: { id: grillingId },
      include: {
        rounds: {
          where: { status: 'ASKING' },
          include: { questions: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!g) throw new NotFoundException('Grilling not found');
    await projectAccess(this.db, user, g.projectId);
    const round = g.status === 'RUNNING' ? g.rounds[0] : undefined;
    if (!round) throw new ConflictException(`This Grilling is ${g.status}, not running`);
    await this.assertHoldsRole(user, g.projectId, round.role);
    const find = () =>
      this.db.conversation.findFirst({
        where: { grillingRoundId: round.id, ownerId: user.id },
        select: { id: true },
      });
    const existing = await find();
    if (existing) return existing.id;
    try {
      await this.db.$transaction((tx) =>
        openGrillingConversations(tx, g, { ...round, grillingId: g.id }, [user.id]),
      );
    } catch (error) {
      // Two tabs at once: the unique (round, owner) index keeps one.
      if ((error as { code?: string })?.code !== 'P2002') throw error;
    }
    const opened = await find();
    if (!opened) throw new Error('The Grilling Conversation was not opened');
    return opened.id;
  }

  /**
   * Before the owner's message is stored: while the round is open, only a
   * holder of its Team Role writes in its Grilling Conversation (403 otherwise,
   * e.g. after leaving the role). Once it is over, anyone gets the closing note.
   */
  async assertCanWrite(user: User, conversationId: string): Promise<void> {
    const conv = await this.load(conversationId);
    const round = conv.grillingRound;
    if (!round || !isOpen(round, round.grilling)) return;
    await this.assertHoldsRole(user, round.grilling.projectId, round.role);
  }

  /**
   * Replies to the owner's trailing message(s) in their Grilling Conversation.
   * Call only while holding the Conversation's lock, after the message is stored.
   * Nothing of the turn is saved when the AI fails (a 502 the owner retries).
   */
  async reply(user: User, conversationId: string): Promise<GrillingTurn> {
    const conv = await this.load(conversationId);
    const round = conv.grillingRound;
    if (!round) throw new Error(`Conversation ${conversationId} is not a Grilling Conversation`);
    const recent = await this.db.conversationMessage.findMany({
      where: { conversationId },
      orderBy: { position: 'desc' },
      take: 20,
    });
    const trailing: MessageRow[] = [];
    for (const m of recent) {
      if (m.role !== 'USER') break;
      trailing.unshift(m);
    }
    const message = trailing.at(-1);
    if (!message) throw new ConflictException('Nothing to reply to');
    const text = trailing
      .map((m) => m.content.trim())
      .join('\n\n')
      .trim();

    let state = stateOf(conv.grillingState);
    const lines: GrillingNote[] = [];

    const wasIdle = !state.questionId;
    const question = round.questions.find((q) => q.id === state.questionId);
    // This message is a reply to the asked question, so if someone else answered it
    // meanwhile, the reply wasn't recorded either.
    const hadReply = state.answer !== null || text.length > 0;
    if (!isOpen(round, round.grilling)) {
      // Someone else may have answered the asked question and closed the round meanwhile.
      if (question?.answeredAt && question.answeredById !== user.id) {
        lines.push(answeredElsewhere(question, nameOf(question), hadReply));
      }
      lines.push(closedText(round, round.grilling));
      return this.finish(user, conv, message, closed(state), lines);
    }

    if (question?.answeredAt) {
      // Answered elsewhere since this Conversation asked it (or by the owner, before a crash).
      if (question.answeredById !== user.id) {
        lines.push(answeredElsewhere(question, nameOf(question), hadReply));
      }
      state = asking(null, state.skipped);
    } else if (question) {
      const skip = isGrillingSkip(text);
      if (skip && state.answer === null) {
        lines.push(skippedText(question));
        state = asking(null, [...state.skipped, question.id]);
      } else {
        if (!skip) state = withReply(state, text);
        if (!skip && state.followUps.length < MAX_GRILLING_FOLLOW_UPS) {
          const followUp = await this.followUp(conv, round, question, state);
          if (followUp) {
            const next = {
              ...state,
              followUps: [...state.followUps, { question: followUp, answer: null }],
            };
            const note: GrillingNote = {
              kind: 'FOLLOW_UP',
              number: next.followUps.length,
              text: followUp,
            };
            return this.finish(user, conv, message, next, [note]);
          }
        }
        const outcome = await this.record(user, conv, question, state);
        if (outcome) lines.push(outcome);
        state = asking(null, state.skipped);
      }
    }

    // What to ask next, from the round as it is now.
    const now = await this.load(conversationId);
    const fresh = now.grillingRound ?? round;
    if (!isOpen(fresh, fresh.grilling)) {
      lines.push(closedText(fresh, fresh.grilling));
      return this.finish(user, conv, message, closed(state), lines);
    }
    let next = nextQuestion(fresh.questions, state.skipped);
    if (!next && wasIdle) {
      // A message after "that's all": go back to the questions the owner skipped.
      state = asking(null, []);
      next = nextQuestion(fresh.questions, []);
    }
    if (next) {
      state = asking(next.id, state.skipped);
      lines.push(ask(next, fresh.questions.length));
    } else {
      const open = fresh.questions.filter((q) => !q.answeredAt).length;
      lines.push(waiting(fresh.role, open));
    }
    return this.finish(user, conv, message, state, lines);
  }

  /** A Grilling Conversation's round and where each of its questions stands, for its view. */
  async progress(conversationId: string): Promise<GrillingConversationProgress | null> {
    const conv = await this.load(conversationId);
    const round = conv.grillingRound;
    if (!round) return null;
    const state = stateOf(conv.grillingState);
    const reached = await this.db.grillingRound.findMany({
      where: { grillingId: round.grilling.id },
      select: { kind: true, status: true, questions: { select: { answeredAt: true } } },
    });
    return {
      rounds: GRILLING_ROUNDS.map(({ kind, role }) => {
        const r = reached.find((x) => x.kind === kind);
        return {
          kind,
          role,
          status: r?.status ?? 'UPCOMING',
          answered: r?.questions.filter((q) => q.answeredAt).length ?? 0,
          total: r?.questions.length ?? 0,
        };
      }),
      grillingStatus: round.grilling.status,
      roundStatus: round.status,
      answered: round.questions.filter((q) => q.answeredAt).length,
      total: round.questions.length,
      questions: round.questions.map((q) => ({
        id: q.id,
        position: q.position,
        text: q.text,
        status: q.answeredAt
          ? 'ANSWERED'
          : q.id === state.questionId && isOpen(round, round.grilling)
            ? 'ASKING'
            : q.skipped || state.skipped.includes(q.id)
              ? 'SKIPPED'
              : 'OPEN',
        answeredBy: q.answeredBy,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        answer: q.answeredAt ? q.answer : null,
        followUps: q.answeredAt ? followUpsOf(q.followUps) : [],
        followUpsAsked: q.id === state.questionId && !q.answeredAt ? state.followUps.length : 0,
      })),
    };
  }

  /**
   * After an answer, a skip or a cancel (whichever path made it): tells the
   * rounds' Grilling Conversations whose question was answered by someone else,
   * or whose round is over. A Conversation busy with a reply is left alone; that
   * reply reads the round as it is now.
   */
  async sync(roundIds: string[]): Promise<void> {
    const convs = await this.db.conversation.findMany({
      where: { grillingRoundId: { in: roundIds } },
      select: { id: true },
    });
    for (const { id } of convs) {
      await this.locks.ifFree(id, () => this.syncOne(id));
    }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  private async syncOne(conversationId: string): Promise<void> {
    const conv = await this.load(conversationId);
    const round = conv.grillingRound;
    if (!round) return;
    let state = stateOf(conv.grillingState);
    const lines: GrillingNote[] = [];
    if (!isOpen(round, round.grilling)) {
      if (state.closed) return;
      // The round may have closed because someone else answered the question asked here.
      const asked = round.questions.find((q) => q.id === state.questionId);
      if (asked?.answeredAt && asked.answeredById !== conv.ownerId) {
        lines.push(answeredElsewhere(asked, nameOf(asked), state.answer !== null));
      }
      lines.push(closedText(round, round.grilling));
      state = closed(state);
    } else {
      const question = round.questions.find((q) => q.id === state.questionId);
      if (!question?.answeredAt) return;
      if (question.answeredById !== conv.ownerId) {
        lines.push(answeredElsewhere(question, nameOf(question), state.answer !== null));
      }
      const next = nextQuestion(round.questions, state.skipped);
      state = asking(next?.id ?? null, state.skipped);
      lines.push(
        next
          ? ask(next, round.questions.length)
          : waiting(round.role, round.questions.filter((q) => !q.answeredAt).length),
      );
    }
    const saved = await this.save(conversationId, conv.ownerId, state, lines);
    this.emit(conv.ownerId, {
      event: 'conversation.appended',
      data: { conversationId, messages: [toConversationMessageView(saved.reply)] },
    });
  }

  /** Asks the AI whether to follow up; a failure is a 502 and nothing of the turn is saved. */
  private async followUp(
    conv: GrillingConv,
    round: AskedRound,
    question: AskedQuestion,
    state: GrillingConversationState,
  ): Promise<string | null> {
    try {
      const decision = await this.ai.grillingFollowUp(
        {
          project: { name: round.grilling.project.name },
          round: round.kind,
          role: round.role,
          question: question.text,
          answer: state.answer ?? '',
          followUps: answered(state),
          remaining: MAX_GRILLING_FOLLOW_UPS - state.followUps.length,
        },
        {
          language: await personLanguage(this.db, conv.ownerId),
          receipt: {
            requestedById: conv.ownerId,
            output: { kind: 'GRILLING_QUESTION', id: question.id },
          },
        },
      );
      return decision.followUp?.trim() || null;
    } catch (error) {
      this.logger.error('A Grilling follow-up failed', error as Error);
      throw this.failed(
        conv,
        'The AI failed while reading your answer, so nothing was saved. Try again.',
      );
    }
  }

  /**
   * Records the owner's answer and follow-ups on the question, through the same
   * service as the Grilling API. Returns what to tell the owner, if anything.
   */
  private async record(
    user: User,
    conv: GrillingConv,
    question: AskedQuestion,
    state: GrillingConversationState,
  ): Promise<GrillingNote | null> {
    const round = conv.grillingRound as AskedRound;
    try {
      await this.grilling.answer(
        user,
        round.grilling.id,
        question.id,
        { answer: state.answer ?? '' },
        answered(state),
      );
      return recorded(question);
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw this.failed(
          conv,
          'The AI failed while moving the Grilling on, so your answer was not saved. Try again.',
        );
      }
      if (!(error instanceof ConflictException)) throw error;
      // Someone else answered it first, or the round ended: say so, from the round as it is now.
      const now = await this.db.grillingQuestion.findUnique({
        where: { id: question.id },
        include: { answeredBy: { select: { id: true, name: true } } },
      });
      if (now?.answeredAt && now.answeredById !== user.id) {
        return answeredElsewhere(now, nameOf(now), true);
      }
      return null;
    }
  }

  /** Saves the state with the reply, tells the owner, and returns the turn. */
  private async finish(
    user: User,
    conv: GrillingConv,
    message: MessageRow,
    state: GrillingConversationState,
    notes: GrillingNote[],
  ): Promise<GrillingTurn> {
    const saved = await this.save(conv.id, conv.ownerId, state, notes);
    this.emit(user.id, {
      event: 'conversation.done',
      data: { conversationId: conv.id, message: toConversationMessageView(saved.reply) },
    });
    return { conversation: saved.conversation, message, reply: saved.reply };
  }

  /** Saves the state and the server's reply, written in the owner's language (0068). */
  private async save(
    conversationId: string,
    ownerId: string,
    state: GrillingConversationState,
    notes: GrillingNote[],
  ) {
    const language = await personLanguage(this.db, ownerId);
    return this.db.$transaction(async (tx) => {
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: { grillingState: toStateJson(state), updatedAt: new Date() },
        include: conversationInclude,
      });
      const { _max } = await tx.conversationMessage.aggregate({
        where: { conversationId },
        _max: { position: true },
      });
      const reply = await tx.conversationMessage.create({
        data: {
          conversationId,
          position: (_max.position ?? -1) + 1,
          role: 'ASSISTANT',
          ...noteMessage(notes, language),
        },
      });
      return { conversation, reply };
    });
  }

  private failed(conv: GrillingConv, reason: string) {
    this.emit(conv.ownerId, {
      event: 'conversation.failed',
      data: { conversationId: conv.id, messageId: randomUUID(), message: reason },
    });
    return replyFailed(conv.id, reason);
  }

  private emit(userId: string, event: ServerEvent) {
    this.bus.emit(userId, event);
  }

  private async load(conversationId: string): Promise<GrillingConv> {
    return this.db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: stateInclude,
    });
  }

  private async assertHoldsRole(user: User, projectId: string, role: AskedRound['role']) {
    const count = await this.db.teamMembership.count({
      where: { userId: user.id, role, team: { projectId } },
    });
    if (!count) {
      throw new ForbiddenException(
        `Only people holding the ${role} Team Role in this Project's Teams answer this round`,
      );
    }
  }
}

/** The state with the owner's reply in place: the answer, or the last follow-up's reply. */
function withReply(state: GrillingConversationState, text: string): GrillingConversationState {
  const last = state.followUps.at(-1);
  if (state.answer === null) return { ...state, answer: text };
  if (last && last.answer === null) {
    return { ...state, followUps: [...state.followUps.slice(0, -1), { ...last, answer: text }] };
  }
  // A second message before any follow-up: part of the same answer.
  return { ...state, answer: `${state.answer}\n\n${text}` };
}

/** The follow-ups that have a reply (one skipped mid-way is left out). */
function answered(state: GrillingConversationState): GrillingFollowUp[] {
  return state.followUps.flatMap((f) =>
    f.answer === null ? [] : [{ question: f.question, answer: f.answer }],
  );
}

function closed(state: GrillingConversationState): GrillingConversationState {
  return { ...asking(null, state.skipped), closed: true };
}

function nameOf(q: { answeredBy: { name: string } | null }): string {
  return q.answeredBy?.name ?? 'Someone';
}
