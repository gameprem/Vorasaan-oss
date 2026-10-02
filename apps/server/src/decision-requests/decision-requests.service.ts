import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type {
  DecideInput,
  DecideResult,
  DecisionRequestView,
  ListDecisionRequestsQuery,
  PostRequestMessageInput,
  RaiseDecisionRequestInput,
  ReassignInput,
  RecordedModel,
  SubmitDecisionRequestInput,
  TeamRole,
} from '@vorasaan/shared';
import {
  AI_PORT,
  AiOutputError,
  type AiPort,
  type DecisionForAi,
  type ModelChoice,
} from '../ai/ai.port.ts';
import { ContextBudgets } from '../ai/context-budget.ts';
import { describeDecision } from '../ai/prompts.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { activeDelegates } from '../delegations/active-delegations.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import { NotificationsService, type Outbox, type Tx } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ResponseWindowsService } from '../response-windows/response-windows.service.ts';
import {
  addWorkingTime,
  MINUTE,
  windowLength,
  workingTimeBetween,
} from '../response-windows/working-time.ts';
import { ContextRetriever, splitFeatureSpec } from '../retrieval/context-retriever.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import { specProposalInclude, toSpecProposalView } from '../spec/spec.view.ts';
import {
  type DecisionRequestEvent,
  InvalidTransitionError,
  nextStatus,
} from './decision-request.state.ts';
import {
  type DecisionRequestWithRelations,
  decisionRequestInclude,
  isClaimant,
  teamRoleKey,
  toDecisionRequestView,
  type Viewer,
} from './decision-request.view.ts';

@Injectable()
export class DecisionRequestsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly notifications: NotificationsService,
    private readonly indexing: IndexingService,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly budgets: ContextBudgets,
    private readonly windows: ResponseWindowsService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /**
   * A DRAFT with AI Choices. `drafting` is set from a Conversation (ticket 0054): the
   * Choices are drafted with its turn's model, which the request records.
   */
  async raise(
    user: User,
    input: RaiseDecisionRequestInput,
    drafting?: { choice: ModelChoice; record: RecordedModel },
  ): Promise<DecisionRequestView> {
    const raiserRole = await this.db.roleOwner.findFirst({
      where: { featureId: input.featureId, userId: user.id },
      orderBy: { role: 'asc' },
    });
    if (!raiserRole) {
      const exists = await this.db.feature.count({ where: { id: input.featureId } });
      if (!exists) throw new NotFoundException('Feature not found');
      throw new ForbiddenException(
        'Only a Role Owner of this Feature can raise a Decision Request',
      );
    }

    const withChoices = input.withChoices ?? true;
    let generated: Awaited<ReturnType<AiPort['generateChoices']>> | undefined;
    if (withChoices) {
      // The budgets are shares of the window of the model the Choices are generated on (0060).
      const { model, budget } = await this.budgets.forTask('generateChoices', 'decisionRequest', {
        model: drafting?.choice,
      });
      const { foundation, contextBudget } = await this.foundation.forFeature(
        input.featureId,
        budget,
      );
      const { spec, context } = splitFeatureSpec(
        await this.retriever.forFeature(
          input.featureId,
          `${input.title}\n\n${input.description}`,
          contextBudget,
        ),
      );
      try {
        generated = await this.ai.generateChoices(
          {
            specMarkdown: spec?.text ?? '(This Feature has no Spec yet.)',
            context: withoutBrief(context),
            foundation,
            request: {
              kind: input.kind,
              title: input.title,
              description: input.description,
              raiserRole: raiserRole.role,
            },
          },
          { model },
        );
      } catch (error) {
        if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
        throw error;
      }
    }

    const created = await this.db.decisionRequest.create({
      data: {
        featureId: input.featureId,
        kind: input.kind,
        withChoices,
        raiserId: user.id,
        title: input.title,
        description: input.description,
        suggestedRole: generated?.suggestedRole ?? null,
        // Provisional until the Raiser confirms it on submit.
        deciderRole: generated?.suggestedRole ?? 'PO',
        ...(generated && drafting
          ? {
              choicesApprovedModelId: drafting.record.approvedModelId,
              choicesModelDisplayName: drafting.record.displayName,
              choicesModelName: drafting.record.modelId,
            }
          : {}),
        choices: {
          create: (generated?.choices ?? []).map((choice, position) => ({ ...choice, position })),
        },
      },
      include: decisionRequestInclude,
    });
    return toDecisionRequestView(created, await this.viewer(user));
  }

  async submit(
    user: User,
    id: string,
    input: SubmitDecisionRequestInput,
  ): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    this.assertRaiser(user, request);
    const status = this.transition(request, 'submit');

    if (input.choices && !request.withChoices) {
      throw new UnprocessableEntityException('This Question was raised without Choices');
    }

    const submittedAt = this.clock.now();
    // The Response Window starts now (ADR 0011): the Project's default for this kind,
    // or a shorter one the Raiser picked. Never a longer one.
    const { calendar, window } = await this.windows.forFeature(
      this.db,
      request.featureId,
      request.kind,
    );
    let windowMs = windowLength(window, calendar);
    if (input.responseWindow) {
      const asked = windowLength(input.responseWindow, calendar);
      if (asked > windowMs) {
        throw new UnprocessableEntityException(
          `The Response Window can only be shortened: this Project gives a ${request.kind === 'BLOCKER' ? 'Blocker' : 'Question'} ${window.value} ${window.unit === 'WORKING_HOURS' ? 'working hour' : 'working day'}${window.value === 1 ? '' : 's'}`,
        );
      }
      windowMs = asked;
    }
    const recipients = await this.chooseRecipients(request, input, submittedAt);
    // Sent to one person → they decide. Sent to several → nobody until one Claims it.
    const deciderId = recipients.length === 1 ? (recipients[0]?.userId ?? null) : null;

    const updated = await this.db.$transaction(async (tx) => {
      if (input.choices) {
        await tx.choice.deleteMany({ where: { requestId: id } });
        await tx.choice.createMany({
          data: input.choices.map((choice, position) => ({
            ...choice,
            position,
            requestId: id,
            editedByUser: true,
          })),
        });
      }
      return tx.decisionRequest.update({
        where: { id, status: request.status },
        data: {
          status,
          deciderRole: input.deciderRole,
          deciderId,
          submittedAt,
          responseWindowMinutes: Math.round(windowMs / MINUTE),
          dueAt: addWorkingTime(submittedAt, windowMs, calendar),
          pausedAt: null,
          escalationStep: 0,
          recipients: { create: recipients },
        },
        include: decisionRequestInclude,
      });
    });
    await this.notifications.publish(
      this.notifications.outbox().inboxChanged(recipients.map((r) => r.userId)),
    );
    return toDecisionRequestView(updated, await this.viewer(user));
  }

  /**
   * Makes the caller the Decider. Allowed with no Decider yet, and also when the request
   * was routed to someone else: the Claim replaces them.
   */
  async claim(user: User, id: string): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    const viewer = await this.viewer(user);
    if (!isClaimant(request, viewer)) {
      throw new ForbiddenException(
        `Only someone else holding the ${request.deciderRole} Team Role can Claim this request`,
      );
    }
    this.transition(request, 'claim');
    if (request.deciderId === user.id) return toDecisionRequestView(request, viewer);

    const outbox = this.notifications.outbox();
    await this.db.$transaction(async (tx) => {
      const moved = await tx.decisionRequest.updateMany({
        where: { id, status: request.status, deciderId: request.deciderId },
        data: { deciderId: user.id },
      });
      if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
      await this.claimed(tx, outbox, user, request);
    });
    await this.notifications.publish(outbox);
    return toDecisionRequestView(await this.findOrThrow(id), viewer);
  }

  /** The Decider hands the request to someone else holding the decider role in the Team. */
  async reassign(user: User, id: string, input: ReassignInput): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    if (request.deciderId !== user.id) {
      throw new ForbiddenException('Only the Decider can reassign this Decision Request');
    }
    this.transition(request, 'reassign');
    if (input.userId === request.raiserId) {
      throw new UnprocessableEntityException('The Decider cannot be the Raiser');
    }
    if (input.userId === user.id) {
      throw new UnprocessableEntityException('You are already the Decider');
    }
    const holdsRole = await this.db.teamMembership.count({
      where: { teamId: request.feature.teamId, userId: input.userId, role: request.deciderRole },
    });
    if (!holdsRole) {
      throw new UnprocessableEntityException(
        `The new Decider must hold the ${request.deciderRole} Team Role in this Team`,
      );
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.decisionRequest.updateMany({
        where: { id, status: request.status, deciderId: user.id },
        data: { deciderId: input.userId },
      });
      if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
      // Decision Lead Time attributes the wait from now on to the new Decider (0056).
      await tx.deciderChange.create({
        data: {
          requestId: id,
          deciderId: input.userId,
          kind: 'REASSIGNED',
          createdAt: this.clock.now(),
        },
      });
    });
    await this.notifications.publish(
      this.notifications.outbox().inboxChanged(user.id, input.userId),
    );
    return toDecisionRequestView(await this.findOrThrow(id), await this.viewer(user));
  }

  /**
   * Adds to the thread between Decider and Raiser. The Decider's QUESTION moves the request
   * to NEEDS_INFO, the Raiser's ANSWER moves it back to OPEN with the same Decider, and a
   * NOTE from either changes nothing.
   */
  async postMessage(
    user: User,
    id: string,
    input: PostRequestMessageInput,
  ): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    const isRaiser = request.raiserId === user.id;
    // While nobody has Claimed it, every recipient counts as the Decider here; asking a
    // QUESTION Claims it implicitly, as deciding would.
    const impliedClaim = this.isImpliedClaim(user, request);
    const isDecider = request.deciderId === user.id || impliedClaim;

    let event: DecisionRequestEvent;
    switch (input.kind) {
      case 'QUESTION':
        if (!isDecider) throw new ForbiddenException('Only the Decider can ask for more info');
        event = 'askForInfo';
        break;
      case 'ANSWER':
        if (!isRaiser) throw new ForbiddenException('Only the Raiser can answer');
        event = 'provideInfo';
        break;
      case 'NOTE':
        if (!isRaiser && !isDecider) {
          throw new ForbiddenException('Only the Raiser or the Decider can add a note');
        }
        event = 'addNote';
        break;
    }
    const status = this.transition(request, event);
    // A note alone never makes anyone the Decider.
    const deciderId = impliedClaim && input.kind === 'QUESTION' ? user.id : request.deciderId;

    const outbox = this.notifications.outbox();
    const clock = await this.pauseOrResume(request, status);
    const updated = await this.db.$transaction(async (tx) => {
      const moved = await tx.decisionRequest.updateMany({
        where: { id, status: request.status, deciderId: request.deciderId },
        data: { status, deciderId, ...clock },
      });
      if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
      // On the clock: NEEDS_INFO spells are rebuilt from these times (Decision Lead Time).
      await tx.requestMessage.create({
        data: {
          requestId: id,
          authorId: user.id,
          kind: input.kind,
          body: input.body,
          createdAt: this.clock.now(),
        },
      });
      if (deciderId !== request.deciderId) await this.claimed(tx, outbox, user, request);
      // A QUESTION or ANSWER moves the item between the Decider's and the Raiser's Inbox.
      if (status !== request.status) outbox.inboxChanged(request.raiserId, deciderId);
      return tx.decisionRequest.findUniqueOrThrow({
        where: { id },
        include: decisionRequestInclude,
      });
    });
    await this.notifications.publish(outbox);
    return toDecisionRequestView(updated, await this.viewer(user));
  }

  /**
   * NEEDS_INFO stops the Response Window's clock; the answer restarts it, moving `dueAt`
   * later by the working time spent waiting for the Raiser (ticket 0055).
   */
  private async pauseOrResume(
    request: DecisionRequestWithRelations,
    to: DecisionRequestWithRelations['status'],
  ): Promise<{ pausedAt?: Date | null; dueAt?: Date }> {
    if (!request.dueAt || to === request.status) return {};
    const now = this.clock.now();
    if (to === 'NEEDS_INFO') return { pausedAt: now };
    if (request.status !== 'NEEDS_INFO' || !request.pausedAt) return {};
    const { calendar } = await this.windows.forFeature(this.db, request.featureId, request.kind);
    const waited = workingTimeBetween(request.pausedAt, now, calendar);
    return { pausedAt: null, dueAt: addWorkingTime(request.dueAt, waited, calendar) };
  }

  async withdraw(user: User, id: string): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    this.assertRaiser(user, request);
    const status = this.transition(request, 'withdraw');
    // The Decider, or while nobody has Claimed it everyone it was sent to.
    const affected = request.deciderId
      ? [request.deciderId]
      : request.recipients.map((r) => r.user.id);
    const outbox = this.notifications.outbox().inboxChanged(affected, request.raiserId);
    const updated = await this.db.$transaction(async (tx) => {
      const updated = await tx.decisionRequest.update({
        where: { id, status: request.status },
        data: { status, closedAt: this.clock.now() },
        include: decisionRequestInclude,
      });
      await this.notifications.notify(tx, outbox, {
        type: 'REQUEST_WITHDRAWN',
        to: affected,
        actorId: user.id,
        featureId: request.featureId,
        requestId: id,
      });
      return updated;
    });
    await this.notifications.publish(outbox);
    return toDecisionRequestView(updated, await this.viewer(user));
  }

  /**
   * Records the Decider's Decision and the AI-drafted Spec Proposal together.
   * The AI runs first, so a failed draft writes nothing and the Decider can retry.
   */
  async decide(user: User, id: string, input: DecideInput): Promise<DecideResult> {
    const request = await this.findOrThrow(id);
    // A recipient deciding a request nobody has Claimed yet Claims it implicitly.
    const impliedClaim = this.isImpliedClaim(user, request);
    if (request.deciderId !== user.id && !impliedClaim) {
      throw new ForbiddenException('Only the Decider can decide this Decision Request');
    }
    const status = this.transition(request, 'decide');
    // Acting as Delegate means the request reached the Decider in place of the delegator.
    const onBehalfOfId =
      request.recipients.find((r) => r.user.id === user.id)?.onBehalfOfId ?? null;

    let decision: DecisionForAi;
    if ('choiceId' in input) {
      const choice = request.choices.find((c) => c.id === input.choiceId);
      if (!choice)
        throw new UnprocessableEntityException('That Choice is not part of this request');
      decision = { kind: 'choice', choice, rationale: input.rationale };
    } else {
      decision = { kind: 'custom', answer: input.customAnswer, rationale: input.rationale };
    }

    const base = await this.db.specVersion.findFirst({
      where: { featureId: request.featureId },
      orderBy: { version: 'desc' },
      select: { id: true, markdown: true },
    });
    const raiserRole = await this.db.roleOwner.findFirst({
      where: { featureId: request.featureId, userId: request.raiserId },
      orderBy: { role: 'asc' },
      select: { role: true },
    });
    // The whole current Spec is sent besides the context, so it is part of the fixed cost.
    const { model, budget } = await this.budgets.forTask('draftSpecProposal', 'decisionRequest', {
      fixed: estimateTokens(base?.markdown ?? ''),
    });
    const { foundation, contextBudget } = await this.foundation.forFeature(
      request.featureId,
      budget,
    );
    const { context } = splitFeatureSpec(
      await this.retriever.forFeature(
        request.featureId,
        `${request.title}\n\n${request.description}\n\n${describeDecision(decision)}`,
        contextBudget,
        { excludeRequestId: request.id },
      ),
    );

    let draft: Awaited<ReturnType<AiPort['draftSpecProposal']>>;
    try {
      draft = await this.ai.draftSpecProposal(
        {
          // The whole current Spec: it is the base the draft edits, never shortened.
          specMarkdown: base?.markdown ?? '',
          context: withoutBrief(context),
          foundation,
          request: {
            kind: request.kind,
            title: request.title,
            description: request.description,
            raiserRole: raiserRole?.role ?? request.deciderRole,
          },
          decision,
        },
        { model },
      );
    } catch (error) {
      if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
      throw error;
    }

    const outbox = this.notifications.outbox().inboxChanged(
      user.id,
      request.recipients.map((r) => r.user.id),
    );
    const { updated, proposal } = await this.db.$transaction(async (tx) => {
      const moved = await tx.decisionRequest.updateMany({
        where: { id, status: request.status, deciderId: request.deciderId },
        data: { status, deciderId: user.id },
      });
      if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
      if (impliedClaim) await this.claimed(tx, outbox, user, request);
      await this.notifications.notify(tx, outbox, {
        type: 'REQUEST_DECIDED',
        to: [request.raiserId],
        actorId: user.id,
        featureId: request.featureId,
        requestId: id,
      });

      const created = await tx.decision.create({
        data: {
          requestId: id,
          decidedById: user.id,
          onBehalfOfId,
          choiceId: 'choiceId' in input ? input.choiceId : null,
          customAnswer: 'customAnswer' in input ? input.customAnswer : null,
          rationale: input.rationale ?? null,
          // On the clock: it ends the request's Decision Lead Time.
          createdAt: this.clock.now(),
        },
      });
      const proposal = await tx.specProposal.create({
        data: {
          featureId: request.featureId,
          baseVersionId: base?.id ?? null,
          source: 'DECISION',
          proposedMarkdown: normalizeMarkdown(draft.proposedMarkdown),
          approverId: user.id,
          decisionId: created.id,
        },
        include: specProposalInclude,
      });
      const updated = await tx.decisionRequest.findUniqueOrThrow({
        where: { id },
        include: decisionRequestInclude,
      });
      return { updated, proposal };
    });
    await this.notifications.publish(outbox);
    if (proposal.decisionId) {
      this.indexing.schedule({ source: 'DECISION', id: proposal.decisionId });
    }

    return {
      request: toDecisionRequestView(updated, await this.viewer(user)),
      proposal: toSpecProposalView(proposal),
    };
  }

  async get(user: User, id: string): Promise<DecisionRequestView> {
    return toDecisionRequestView(await this.findOrThrow(id), await this.viewer(user));
  }

  async list(user: User, query: ListDecisionRequestsQuery): Promise<DecisionRequestView[]> {
    const requests = await this.db.decisionRequest.findMany({
      where: {
        deciderId: query.decider === 'me' ? user.id : undefined,
        raiserId: query.raiser === 'me' ? user.id : undefined,
        status: query.status,
        // Sent to me and still mine to Claim or decide, which only an OPEN request is.
        ...(query.recipient === 'me' && {
          status: 'OPEN',
          recipients: { some: { userId: user.id } },
          OR: [{ deciderId: null }, { deciderId: user.id }],
        }),
      },
      orderBy: { createdAt: 'desc' },
      include: decisionRequestInclude,
    });
    const viewer = await this.viewer(user);
    return requests.map((r) => toDecisionRequestView(r, viewer));
  }

  /**
   * Who the request goes to. The candidates are the Feature's Role Owners for the role or,
   * when it has none, the Team members holding it; the Raiser is never one of them. Then a
   * chosen person with an active Delegation for the role is replaced by their Delegate,
   * who is recorded as receiving it on the delegator's behalf: one hop only, never the
   * Raiser, and nobody twice (someone chosen in their own right keeps no delegator).
   */
  private async chooseRecipients(
    request: DecisionRequestWithRelations,
    input: SubmitDecisionRequestInput,
    at: Date,
  ): Promise<{ userId: string; onBehalfOfId: string | null }[]> {
    const role = input.deciderRole;
    const candidates = (
      await this.candidates(
        {
          featureId: request.featureId,
          teamId: request.feature.teamId,
          raiserId: request.raiserId,
        },
        role,
      )
    ).map((p) => p.id);
    if (!candidates.length) {
      throw new UnprocessableEntityException(
        `Nobody but the Raiser holds the ${role} Team Role for this Feature`,
      );
    }

    const recipients = input.recipients ?? 'ALL';
    if (recipients !== 'ALL' && !candidates.includes(recipients.userId)) {
      throw new UnprocessableEntityException(
        `That person cannot receive this request as ${role}: send it to one of the Feature's ${role} Role Owners`,
      );
    }
    const chosen = recipients === 'ALL' ? candidates : [recipients.userId];

    const delegates = await activeDelegates(this.db, {
      teamId: request.feature.teamId,
      role,
      delegatorIds: chosen,
      at,
    });
    const onBehalfOf = new Map<string, string | null>();
    for (const id of chosen) {
      const delegateId = delegates.get(id);
      if (delegateId && delegateId !== request.raiserId) {
        if (!onBehalfOf.has(delegateId)) onBehalfOf.set(delegateId, id);
      } else {
        onBehalfOf.set(id, null);
      }
    }
    return [...onBehalfOf].map(([userId, onBehalfOfId]) => ({ userId, onBehalfOfId }));
  }

  /**
   * Who may receive a request as `role`: the Feature's Role Owners for it or, when
   * it has none, the Team members holding it. Never the Raiser. Before any
   * Delegation applies (see chooseRecipients).
   */
  async candidates(
    request: { featureId: string; teamId: string; raiserId: string },
    role: TeamRole,
  ): Promise<{ id: string; name: string }[]> {
    const others = { not: request.raiserId };
    const select = { user: { select: { id: true, name: true } } } as const;
    const owners = await this.db.roleOwner.findMany({
      where: { featureId: request.featureId, role, userId: others },
      select,
      orderBy: { user: { name: 'asc' } },
    });
    if (owners.length) return owners.map((o) => o.user);
    const members = await this.db.teamMembership.findMany({
      where: { teamId: request.teamId, role, userId: others },
      select,
      orderBy: { user: { name: 'asc' } },
    });
    return members.map((m) => m.user);
  }

  private async viewer(user: User): Promise<Viewer> {
    const memberships = await this.db.teamMembership.findMany({
      where: { userId: user.id },
      select: { teamId: true, role: true },
    });
    return {
      userId: user.id,
      teamRoles: new Set(memberships.map((m) => teamRoleKey(m.teamId, m.role))),
    };
  }

  private async findOrThrow(id: string): Promise<DecisionRequestWithRelations> {
    const request = await this.db.decisionRequest.findUnique({
      where: { id },
      include: decisionRequestInclude,
    });
    if (!request) throw new NotFoundException('Decision Request not found');
    return request;
  }

  /**
   * `user` just became the Decider: REQUEST_CLAIMED to the other recipients and to the
   * Decider it replaced, whose Inbox Items all change. The Claim is recorded with its
   * time, for Decision Lead Time (ticket 0056).
   */
  private async claimed(tx: Tx, outbox: Outbox, user: User, request: DecisionRequestWithRelations) {
    await tx.deciderChange.create({
      data: {
        requestId: request.id,
        deciderId: user.id,
        kind: 'CLAIMED',
        createdAt: this.clock.now(),
      },
    });
    const others = [request.deciderId, ...request.recipients.map((r) => r.user.id)];
    outbox.inboxChanged(user.id, others);
    await this.notifications.notify(tx, outbox, {
      type: 'REQUEST_CLAIMED',
      to: others,
      actorId: user.id,
      featureId: request.featureId,
      requestId: request.id,
    });
  }

  /** A recipient acting on a request that has no Decider yet becomes its Decider. */
  private isImpliedClaim(user: User, request: DecisionRequestWithRelations): boolean {
    return request.deciderId === null && request.recipients.some((r) => r.user.id === user.id);
  }

  private assertRaiser(user: User, request: DecisionRequestWithRelations) {
    if (request.raiserId !== user.id) {
      throw new ForbiddenException('Only the Raiser can do this');
    }
  }

  private transition(request: DecisionRequestWithRelations, event: DecisionRequestEvent) {
    try {
      return nextStatus(request.status, event);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
