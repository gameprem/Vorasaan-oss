import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { GrillingRoundKind, Prisma, PrismaClient, TeamRole, User } from '@vorasaan/db';
import {
  type AnswerGrillingQuestionInput,
  BRIEF_TEMPLATE,
  GRILLING_ROUNDS,
  type GrillingFollowUp,
  type GrillingView,
  MAX_GRILLING_QUESTIONS,
  type SkipGrillingRoundInput,
} from '@vorasaan/shared';
import { briefProposalDetail, toActionCardView } from '../action-cards/action-card.view.ts';
import {
  AI_PORT,
  AiOutputError,
  type AiPort,
  type GrillingAnswerForAi,
  type GuidelineForAi,
} from '../ai/ai.port.ts';
import { ContextBudgets, projectBudget } from '../ai/context-budget.ts';
import {
  emptyMemory,
  rememberRound,
  renderMemory,
  type WorkflowMemory,
} from '../ai/workflow-memory.ts';
import { assertCanEditProject, type ProjectAccess, projectAccess } from '../brief/brief-access.ts';
import { toConversationMessageView } from '../conversations/conversation.view.ts';
import { FeatureGuidelinesService } from '../feature-guidelines/feature-guidelines.service.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { NotificationsService, type Tx } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ContextRetriever, splitProjectBrief } from '../retrieval/context-retriever.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import { awaitingGrillingsWhere } from './awaiting.ts';
import {
  followUpsOf,
  type GrillingRoundWithQuestions,
  type GrillingWithRelations,
  grillingInclude,
  toGrillingView,
} from './grilling.view.ts';
import {
  type BriefCardPlaced,
  openGrillingConversations,
  placeBriefProposal,
} from './grilling-conversation.ts';

const LABEL: Record<GrillingRoundKind, string> = {
  BUSINESS: 'Business',
  UX: 'UX',
  TECHNICAL: 'Technical',
};

/** What each round retrieves the Project's context for. */
const ROUND_QUERY: Record<GrillingRoundKind, string> = {
  BUSINESS: 'business goals KPIs target users markets constraints non-goals deadlines budget',
  UX: 'users user journeys screens platforms devices accessibility localisation design',
  TECHNICAL:
    'architecture systems modules routes dependencies integrations data performance security',
};
const DRAFT_QUERY =
  'business goals target users current capabilities features constraints non-goals';

/** BriefVersion summaries are one line; see WriteBriefInput. */
const MAX_SUMMARY_CHARS = 200;
/** How often an answer is retried when others change the Grilling at the same moment. */
const MAX_ATTEMPTS = 3;

type NewRound = {
  kind: GrillingRoundKind;
  role: TeamRole;
  status: 'ASKING' | 'SKIPPED';
  skipReason: 'NO_ONE_WITH_ROLE' | 'NOTHING_TO_ASK' | null;
  questions: string[];
};

/**
 * What moving a Grilling on will write, worked out (with every AI call) before
 * any write: the rounds reached, until one has questions for someone, or else
 * the Brief Proposal drafted after the last round.
 */
type Plan = {
  memory: WorkflowMemory;
  rounds: NewRound[];
  asking: NewRound | null;
  draft: { markdown: string; summary: string; baseVersionId: string | null } | null;
};

/** Thrown inside a transaction when the Grilling changed since it was read. */
class StaleStateError extends Error {}

/**
 * Grilling (ticket 0032, REQUIREMENT §3.8): rounds of AI-asked questions,
 * business → UX → technical, to the people holding each round's Team Role in
 * the Project's Teams, then a Brief Proposal for the starter to approve (0030).
 *
 * A Grilling spans days and many people, so its state lives in Postgres
 * (Grilling, GrillingRound, GrillingQuestion), not in a Mastra workflow
 * snapshot. Between rounds the AI gets short round summaries (WorkflowMemory)
 * and freshly retrieved Project context (ADR 0007), not the transcript.
 *
 * Every move (start, the answer that completes a round, a skip) makes its AI
 * calls first and then writes everything in one transaction, under a row lock
 * and a revision check. A failed AI call is a 502 and writes nothing.
 */
@Injectable()
export class GrillingService {
  private readonly logger = new Logger(GrillingService.name);
  /** Told, after commit, which rounds changed (GrillingConversationsService keeps the Grilling Conversations in step). */
  private readonly roundListeners: ((roundIds: string[]) => Promise<void>)[] = [];

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly retriever: ContextRetriever,
    private readonly budgets: ContextBudgets,
    private readonly guidelines: FeatureGuidelinesService,
    private readonly notifications: NotificationsService,
    private readonly bus: EventBus,
  ) {}

  /** The Project's POs and Admins start one; at most one runs per Project. */
  async start(user: User, projectId: string): Promise<GrillingView> {
    await assertCanEditProject(this.db, user, projectId);
    const running = await this.db.grilling.count({ where: { projectId, status: 'RUNNING' } });
    if (running) throw alreadyRunning();
    const project = await this.db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    const plan = await this.advance(project, emptyMemory(), [], 0);
    let id: string;
    let placed: BriefCardPlaced | null = null;
    try {
      id = await this.db.$transaction(async (tx) => {
        const created = await tx.grilling.create({
          data: { projectId, startedById: user.id, memory: toJson(emptyMemory()) },
        });
        placed = await this.apply(tx, { ...created }, plan);
        return created.id;
      });
    } catch (error) {
      // The partial unique index: another start won the race.
      if ((error as { code?: string })?.code === 'P2002') throw alreadyRunning();
      throw error;
    }
    await this.publish(projectId, [plan.asking?.role], plan.draft ? [user.id] : []);
    await this.announceBriefCard(placed);
    return this.get(user, id);
  }

  async get(user: User, id: string): Promise<GrillingView> {
    return this.view(user, await this.findOrThrow(id));
  }

  /** Every Grilling of the Project, newest first. Everyone in its Organization reads them. */
  async listForProject(user: User, projectId: string): Promise<GrillingView[]> {
    await projectAccess(this.db, user, projectId);
    const grillings = await this.db.grilling.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: grillingInclude,
    });
    return Promise.all(grillings.map((g) => this.view(user, g)));
  }

  /** `GET /grillings?awaiting=me`: RUNNING Grillings whose current round is asked of me. */
  async awaiting(user: User): Promise<GrillingView[]> {
    const where = await awaitingGrillingsWhere(this.db, user.id);
    if (!where) return [];
    const grillings = await this.db.grilling.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      include: grillingInclude,
    });
    return Promise.all(grillings.map((g) => this.view(user, g)));
  }

  /**
   * Anyone holding the current round's Team Role in one of the Project's Teams
   * answers one of its questions. The answer that completes the round moves the
   * Grilling on: next round's questions, or the Brief Proposal after the last.
   */
  async answer(
    user: User,
    id: string,
    questionId: string,
    input: AnswerGrillingQuestionInput,
    /** The follow-ups asked in the answerer's Grilling Conversation, and their replies (0044). */
    followUps: GrillingFollowUp[] = [],
  ): Promise<GrillingView> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const g = await this.findOrThrow(id);
      await projectAccess(this.db, user, g.projectId);
      const question = g.rounds.flatMap((r) => r.questions).find((q) => q.id === questionId);
      if (!question) throw new NotFoundException('Question not found in this Grilling');
      const round = asking(g);
      if (question.roundId !== round.id) {
        throw new ConflictException('The round of this question is over');
      }
      await this.assertHoldsRole(user, g.projectId, round);
      if (question.answeredAt)
        throw new ConflictException('Someone already answered this question');

      const answer = { questionId, text: input.answer, by: user.name, followUps };
      const completes = round.questions.every((q) => q.id === questionId || q.answeredAt);
      const plan = completes
        ? await this.advance(
            g.project,
            rememberRound(memoryOf(g), roundSummary(round, false, answer)),
            answersOf(g, answer),
            nextIndex(round.kind),
          )
        : null;
      let placed: BriefCardPlaced | null = null;
      try {
        await this.db.$transaction(async (tx) => {
          placed = null;
          const locked = await lock(tx, g.id);
          if (plan) {
            // The plan was made from this exact state; anything since means redo it.
            if (locked.revision !== g.revision) throw new StaleStateError();
          } else {
            // Others may have answered other questions meanwhile; only this round matters.
            const current = await tx.grillingRound.findUnique({
              where: { id: round.id },
              select: {
                status: true,
                questions: { where: { answeredAt: null }, select: { id: true } },
              },
            });
            const open = current?.questions.map((q) => q.id) ?? [];
            const stillOpen = locked.status === 'RUNNING' && current?.status === 'ASKING';
            if (!stillOpen || !open.includes(questionId) || open.length === 1) {
              throw new StaleStateError();
            }
          }
          await bump(tx, g.id);
          const written = await tx.grillingQuestion.updateMany({
            where: { id: questionId, answeredAt: null },
            data: {
              answer: input.answer,
              answeredById: user.id,
              answeredAt: new Date(),
              followUps: followUps.length
                ? (followUps as unknown as Prisma.InputJsonValue)
                : undefined,
            },
          });
          if (written.count !== 1) throw new StaleStateError();
          if (plan) {
            await tx.grillingRound.update({
              where: { id: round.id },
              data: { status: 'ANSWERED', completedAt: new Date() },
            });
            placed = await this.apply(tx, g, plan);
          }
        });
      } catch (error) {
        if (error instanceof StaleStateError) continue;
        throw error;
      }
      const roles = [round.role, plan?.asking?.role];
      await this.publish(g.projectId, roles, plan?.draft ? [g.startedById] : []);
      await this.announceBriefCard(placed);
      await this.roundsChanged([round.id]);
      return this.get(user, id);
    }
    throw changedMeanwhile();
  }

  /**
   * The starter (or an Admin) skips the current round: its unanswered questions
   * are left, its answers still count, and the Grilling moves on.
   */
  async skipRound(user: User, id: string, input: SkipGrillingRoundInput): Promise<GrillingView> {
    const g = await this.findOrThrow(id);
    await this.assertCanManage(user, g);
    const round = asking(g);
    if (round.kind !== input.round) {
      throw new ConflictException(`The current round is ${round.kind}, not ${input.round}`);
    }
    const plan = await this.advance(
      g.project,
      rememberRound(memoryOf(g), roundSummary(round, true)),
      answersOf(g),
      nextIndex(round.kind),
    );
    let placed: BriefCardPlaced | null = null;
    await this.write(g, async (tx) => {
      await tx.grillingRound.update({
        where: { id: round.id },
        data: { status: 'SKIPPED', skipReason: 'BY_STARTER', completedAt: new Date() },
      });
      await tx.grillingQuestion.updateMany({
        where: { roundId: round.id, answeredAt: null },
        data: { skipped: true },
      });
      placed = await this.apply(tx, g, plan);
    });
    await this.publish(
      g.projectId,
      [round.role, plan.asking?.role],
      plan.draft ? [g.startedById] : [],
    );
    await this.announceBriefCard(placed);
    await this.roundsChanged([round.id]);
    return this.get(user, id);
  }

  /**
   * The starter (or an Admin) cancels a RUNNING Grilling, or a DRAFTED one whose
   * Brief Proposal is still pending (the proposal is then rejected). No Brief
   * Version ever comes of a cancelled Grilling.
   */
  async cancel(user: User, id: string): Promise<GrillingView> {
    const g = await this.findOrThrow(id);
    await this.assertCanManage(user, g);
    if (g.status === 'CANCELLED') throw new ConflictException('This Grilling is already cancelled');
    if (g.status === 'DRAFTED' && g.proposal?.status !== 'PENDING') {
      throw new ConflictException('Its Brief Proposal was already reviewed');
    }
    const round = g.rounds.find((r) => r.status === 'ASKING');
    await this.write(g, async (tx) => {
      await tx.grilling.update({
        where: { id: g.id },
        data: { status: 'CANCELLED', currentRound: null },
      });
      if (g.proposal) {
        const rejected = await tx.briefProposal.updateMany({
          where: { id: g.proposal.id, status: 'PENDING' },
          data: { status: 'REJECTED', reviewedAt: new Date() },
        });
        if (rejected.count !== 1) throw new StaleStateError();
      }
    });
    await this.publish(g.projectId, [round?.role], [g.startedById]);
    if (round) await this.roundsChanged([round.id]);
    return this.get(user, id);
  }

  // ─── Moving on ─────────────────────────────────────────────────────────────

  /**
   * From round `from` on: a round nobody holds the Team Role for is skipped, a
   * round the AI has nothing to ask about is skipped, and the first round with
   * questions is where the Grilling waits. After the last round, the Brief is
   * drafted from every answer. Only reads and AI calls; `apply` writes the result.
   */
  private async advance(
    project: { id: string; name: string },
    memory: WorkflowMemory,
    answers: GrillingAnswerForAi[],
    from: number,
  ): Promise<Plan> {
    const guidelines = await this.guidelinesFor(project.id);
    const rounds: NewRound[] = [];
    let known = memory;
    for (const { kind, role } of GRILLING_ROUNDS.slice(from)) {
      if (!(await this.holders(project.id, [role])).length) {
        known = rememberRound(
          known,
          `${LABEL[kind]} round skipped: nobody in the Project's Teams holds the ${role} Team Role.`,
        );
        rounds.push({
          kind,
          role,
          status: 'SKIPPED',
          skipReason: 'NO_ONE_WITH_ROLE',
          questions: [],
        });
        continue;
      }
      const { model, budget } = await this.budgets.forTask('grillingQuestions', 'grilling', {
        fixed: estimateTokens(renderMemory(known)),
      });
      const projectContext = await this.retriever.forProject(
        project.id,
        `${project.name}\n${ROUND_QUERY[kind]}`,
        projectBudget(budget),
      );
      const memoryNow = known;
      const drafted = await this.callAi(() =>
        this.ai.grillingQuestions(
          {
            project: { name: project.name },
            round: kind,
            role,
            projectContext,
            guidelines,
            memory: memoryNow,
          },
          { model },
        ),
      );
      const questions = distinct(drafted.questions).slice(0, MAX_GRILLING_QUESTIONS);
      if (!questions.length) {
        known = rememberRound(
          known,
          `${LABEL[kind]} round (${role}): what is already known answers it; nothing was asked.`,
        );
        rounds.push({ kind, role, status: 'SKIPPED', skipReason: 'NOTHING_TO_ASK', questions: [] });
        continue;
      }
      const round: NewRound = { kind, role, status: 'ASKING', skipReason: null, questions };
      rounds.push(round);
      return { memory: known, rounds, asking: round, draft: null };
    }

    const base = await this.db.briefVersion.findFirst({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: { id: true, markdown: true },
    });
    // The whole Brief, the memory and the answers are sent besides the context (0060).
    const briefMarkdown = base?.markdown ?? BRIEF_TEMPLATE;
    const { model, budget } = await this.budgets.forTask('draftBriefFromGrilling', 'grilling', {
      fixed:
        estimateTokens(briefMarkdown) +
        estimateTokens(renderMemory(known)) +
        estimateTokens(JSON.stringify(answers)),
    });
    const { context } = splitProjectBrief(
      await this.retriever.forProject(
        project.id,
        `${project.name}\n${DRAFT_QUERY}`,
        projectBudget(budget),
      ),
    );
    const memoryNow = known;
    const draft = await this.callAi(() =>
      this.ai.draftBriefFromGrilling(
        {
          project: { name: project.name },
          // The whole current Brief: it is the base the draft edits, never shortened.
          briefMarkdown,
          projectContext: context,
          guidelines,
          memory: memoryNow,
          answers,
        },
        { model },
      ),
    );
    return {
      memory: known,
      rounds,
      asking: null,
      draft: {
        markdown: normalizeMarkdown(draft.proposedMarkdown),
        summary: oneLine(draft.summary),
        baseVersionId: base?.id ?? null,
      },
    };
  }

  /**
   * Writes a Plan inside the caller's transaction. A drafted Brief Proposal is also
   * put in the starter's Conversation as an Action Card (0047), returned to announce.
   */
  private async apply(
    tx: Tx,
    g: { id: string; projectId: string; startedById: string },
    plan: Plan,
  ): Promise<BriefCardPlaced | null> {
    for (const round of plan.rounds) {
      const created = await tx.grillingRound.create({
        data: {
          grillingId: g.id,
          kind: round.kind,
          role: round.role,
          status: round.status,
          skipReason: round.skipReason,
          completedAt: round.status === 'SKIPPED' ? new Date() : null,
          questions: {
            create: round.questions.map((text, position) => ({ grillingId: g.id, position, text })),
          },
        },
        include: { questions: { orderBy: { position: 'asc' } } },
      });
      // Each holder of the round's Team Role gets their own Grilling Conversation (0044).
      if (round.status === 'ASKING') await openGrillingConversations(tx, g, created);
    }
    if (!plan.draft) {
      await tx.grilling.update({
        where: { id: g.id },
        data: { currentRound: plan.asking?.kind ?? null, memory: toJson(plan.memory) },
      });
      return null;
    }
    const proposal = await tx.briefProposal.create({
      data: {
        projectId: g.projectId,
        baseVersionId: plan.draft.baseVersionId,
        source: 'GRILLING',
        proposedMarkdown: plan.draft.markdown,
        summary: plan.draft.summary,
        // The starter approves: the PO or Admin who asked for the Brief.
        approverId: g.startedById,
      },
    });
    await tx.grilling.update({
      where: { id: g.id },
      data: {
        status: 'DRAFTED',
        currentRound: null,
        memory: toJson(plan.memory),
        proposalId: proposal.id,
      },
    });
    return placeBriefProposal(tx, g, proposal);
  }

  /** Tells the starter, after commit, about the Brief Proposal's message and Action Card. */
  private async announceBriefCard(placed: BriefCardPlaced | null): Promise<void> {
    if (!placed) return;
    try {
      const card = await this.db.actionCard.findUniqueOrThrow({ where: { id: placed.cardId } });
      const message = await this.db.conversationMessage.findUniqueOrThrow({
        where: { id: placed.messageId },
      });
      this.bus.emit(placed.ownerId, {
        event: 'conversation.appended',
        data: {
          conversationId: card.conversationId,
          messages: [toConversationMessageView(message)],
        },
      });
      this.bus.emit(placed.ownerId, {
        event: 'conversation.actionCard.created',
        data: {
          conversationId: card.conversationId,
          card: toActionCardView(card, await briefProposalDetail(this.db, card.targetId)),
        },
      });
    } catch (error) {
      this.logger.error('Announcing the Brief Proposal card failed', error as Error);
    }
  }

  /** Runs `change` in a transaction, as long as the Grilling is still as it was read. */
  private async write(g: GrillingWithRelations, change: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const locked = await lock(tx, g.id);
        if (locked.revision !== g.revision) throw new StaleStateError();
        await bump(tx, g.id);
        await change(tx);
      });
    } catch (error) {
      if (error instanceof StaleStateError) throw changedMeanwhile();
      throw error;
    }
  }

  /** A failed or invalid AI call is a 502; the caller has written nothing yet. */
  private async callAi<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
      this.logger.error('A Grilling AI call failed', error as Error);
      throw new BadGatewayException('The AI call failed, so nothing was changed. Try again.');
    }
  }

  // ─── People ────────────────────────────────────────────────────────────────

  /** The people holding one of these Team Roles in any of the Project's Teams. */
  private async holders(projectId: string, roles: (TeamRole | null | undefined)[]) {
    const wanted = roles.filter((r): r is TeamRole => !!r);
    if (!wanted.length) return [];
    const rows = await this.db.teamMembership.findMany({
      where: { role: { in: wanted }, team: { projectId } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async holdsRole(user: User, projectId: string, role: TeamRole): Promise<boolean> {
    const count = await this.db.teamMembership.count({
      where: { userId: user.id, role, team: { projectId } },
    });
    return count > 0;
  }

  private async assertHoldsRole(user: User, projectId: string, round: GrillingRoundWithQuestions) {
    if (!(await this.holdsRole(user, projectId, round.role))) {
      throw new ForbiddenException(
        `Only people holding the ${round.role} Team Role in this Project's Teams answer the ${LABEL[round.kind]} round`,
      );
    }
  }

  /** The starter, while they may still edit the Project, or an Admin. */
  private canManage(user: User, g: GrillingWithRelations, access: ProjectAccess): boolean {
    return access.isAdmin || (g.startedById === user.id && access.canEdit);
  }

  private async assertCanManage(user: User, g: GrillingWithRelations): Promise<void> {
    const access = await projectAccess(this.db, user, g.projectId);
    if (!this.canManage(user, g, access)) {
      throw new ForbiddenException('Only whoever started this Grilling, or an Admin, can do this');
    }
  }

  /** Tells the holders of these Team Roles (and `also`) that their Inbox changed, after commit. */
  private async publish(
    projectId: string,
    roles: (TeamRole | null | undefined)[],
    also: string[],
  ): Promise<void> {
    const outbox = this.notifications.outbox();
    outbox.inboxChanged(await this.holders(projectId, roles), also);
    await this.notifications.publish(outbox);
  }

  /**
   * Registers a listener told, after commit, which rounds an answer, a skip or a
   * cancel changed. GrillingConversationsService uses it to tell the other
   * holders' Grilling Conversations.
   */
  onRoundsChanged(listener: (roundIds: string[]) => Promise<void>): void {
    this.roundListeners.push(listener);
  }

  /** Runs the listeners; what they do is a courtesy, so a failure is logged, not thrown. */
  private async roundsChanged(roundIds: string[]): Promise<void> {
    for (const listener of this.roundListeners) {
      try {
        await listener(roundIds);
      } catch (error) {
        this.logger.error('Updating the Grilling Conversations failed', error as Error);
      }
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  private async guidelinesFor(projectId: string): Promise<GuidelineForAi[]> {
    const criteria = await this.guidelines.effective(projectId);
    return criteria.map(({ title, description, kind, required }) => ({
      title,
      description,
      kind,
      required,
    }));
  }

  private async findOrThrow(id: string) {
    const g = await this.db.grilling.findUnique({
      where: { id },
      include: { ...grillingInclude, project: { select: { id: true, name: true } } },
    });
    if (!g) throw new NotFoundException('Grilling not found');
    return g;
  }

  private async view(user: User, g: GrillingWithRelations): Promise<GrillingView> {
    const access = await projectAccess(this.db, user, g.projectId);
    const round = g.status === 'RUNNING' ? g.rounds.find((r) => r.status === 'ASKING') : undefined;
    const canAnswer = round ? await this.holdsRole(user, g.projectId, round.role) : false;
    return toGrillingView(g, { canAnswer, canManage: this.canManage(user, g, access) });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The round waiting for answers; 409 when the Grilling is no longer running. */
function asking(g: GrillingWithRelations): GrillingRoundWithQuestions {
  const round = g.status === 'RUNNING' ? g.rounds.find((r) => r.status === 'ASKING') : undefined;
  if (!round) throw new ConflictException(`This Grilling is ${g.status}, not running`);
  return round;
}

function nextIndex(kind: GrillingRoundKind): number {
  return GRILLING_ROUNDS.findIndex((r) => r.kind === kind) + 1;
}

function roundOrder(kind: GrillingRoundKind): number {
  return GRILLING_ROUNDS.findIndex((r) => r.kind === kind);
}

type PendingAnswer = {
  questionId: string;
  text: string;
  /** The answerer's name. */
  by: string;
  followUps: GrillingFollowUp[];
};

/** A question's answer, who gave it and its follow-ups, with `pending` (not saved yet) in its place. */
function answerOf(q: GrillingRoundWithQuestions['questions'][number], pending?: PendingAnswer) {
  if (q.id === pending?.questionId) {
    return { text: pending.text, by: pending.by, followUps: pending.followUps };
  }
  if (!q.answer) return null;
  return { text: q.answer, by: q.answeredBy?.name ?? null, followUps: followUpsOf(q.followUps) };
}

/**
 * Every answer so far, round by round, with who gave it (as the round's Team
 * Role) and its follow-ups, so the Brief draft keeps the attribution (0044).
 */
function answersOf(g: GrillingWithRelations, pending?: PendingAnswer): GrillingAnswerForAi[] {
  return [...g.rounds]
    .sort((a, b) => roundOrder(a.kind) - roundOrder(b.kind))
    .flatMap((round) =>
      round.questions.flatMap((q): GrillingAnswerForAi[] => {
        const answer = answerOf(q, pending);
        if (!answer) return [];
        return [
          {
            round: round.kind,
            question: q.text,
            answer: answer.text,
            answeredBy: answer.by ? { name: answer.by, role: round.role } : null,
            followUps: answer.followUps,
          },
        ];
      }),
    );
}

/**
 * A round's memory entry (ADR 0007): its questions and answers in short. The
 * answers are people's words; `renderMemory` fences them in the prompt, and
 * `rememberRound` shortens the entry.
 */
function roundSummary(
  round: GrillingRoundWithQuestions,
  skipped: boolean,
  pending?: PendingAnswer,
): string {
  const answered = round.questions.flatMap((q) => {
    const answer = answerOf(q, pending);
    if (!answer) return [];
    const more = answer.followUps.map((f) => ` Follow-up: ${f.question} A: ${f.answer}`).join('');
    return [`Q: ${q.text} A: ${`${answer.text}${more}`.replace(/\s+/g, ' ').trim()}`];
  });
  const head = skipped
    ? `${LABEL[round.kind]} round (${round.role}), skipped by the starter after ${answered.length} of ${round.questions.length} answers`
    : `${LABEL[round.kind]} round (${round.role})`;
  return [`${head}:`, ...answered].join('\n');
}

function memoryOf(g: { memory: Prisma.JsonValue }): WorkflowMemory {
  const value = g.memory as { rounds?: unknown } | null;
  return Array.isArray(value?.rounds) ? (value as WorkflowMemory) : emptyMemory();
}

function toJson(memory: WorkflowMemory): Prisma.InputJsonValue {
  return memory as unknown as Prisma.InputJsonValue;
}

function distinct(questions: string[]): string[] {
  const seen = new Set<string>();
  return questions
    .map((q) => q.trim())
    .filter((q) => {
      const key = q.toLowerCase();
      if (!q || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_SUMMARY_CHARS ? line : `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Locks the Grilling row for the rest of the transaction; every change goes through it. */
async function lock(tx: Tx, id: string): Promise<{ revision: number; status: string }> {
  const rows = await tx.$queryRaw<{ revision: number; status: string }[]>`
    SELECT "revision", "status"::text AS "status" FROM "Grilling" WHERE "id" = ${id} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new StaleStateError();
  return row;
}

async function bump(tx: Tx, id: string): Promise<void> {
  await tx.grilling.update({ where: { id }, data: { revision: { increment: 1 } } });
}

function alreadyRunning() {
  return new ConflictException('A Grilling is already running in this Project');
}

function changedMeanwhile() {
  return new ConflictException('This Grilling changed meanwhile. Reload and try again.');
}
