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
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import { AI_PORT, AiOutputError, type AiPort, type DecisionForAi } from '../ai/ai.port.ts';
import { ATTACHMENT_CONTEXT_BUDGET, attachmentsForAi } from '../attachments/attachment-context.ts';
import { activeDelegates } from '../delegations/active-delegations.ts';
import { NotificationsService, type Outbox, type Tx } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
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
  ) {}

  async raise(user: User, input: RaiseDecisionRequestInput): Promise<DecisionRequestView> {
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
      const spec = await this.latestSpecMarkdown(input.featureId);
      const attachments = await this.attachmentContext(input.featureId);
      try {
        generated = await this.ai.generateChoices({
          specMarkdown: spec,
          attachments,
          request: {
            kind: input.kind,
            title: input.title,
            description: input.description,
            raiserRole: raiserRole.role,
          },
        });
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

    const submittedAt = new Date();
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

    const moved = await this.db.decisionRequest.updateMany({
      where: { id, status: request.status, deciderId: user.id },
      data: { deciderId: input.userId },
    });
    if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
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
    const updated = await this.db.$transaction(async (tx) => {
      const moved = await tx.decisionRequest.updateMany({
        where: { id, status: request.status, deciderId: request.deciderId },
        data: { status, deciderId },
      });
      if (moved.count !== 1) throw new ConflictException('This Decision Request changed meanwhile');
      await tx.requestMessage.create({
        data: { requestId: id, authorId: user.id, kind: input.kind, body: input.body },
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
        data: { status, closedAt: new Date() },
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
    const attachments = await this.attachmentContext(request.featureId);

    let draft: Awaited<ReturnType<AiPort['draftSpecProposal']>>;
    try {
      draft = await this.ai.draftSpecProposal({
        specMarkdown: base?.markdown ?? '',
        attachments,
        request: {
          kind: request.kind,
          title: request.title,
          description: request.description,
          raiserRole: raiserRole?.role ?? request.deciderRole,
        },
        decision,
      });
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
    const others = { not: request.raiserId };
    let candidates = (
      await this.db.roleOwner.findMany({
        where: { featureId: request.featureId, role, userId: others },
        select: { userId: true },
      })
    ).map((o) => o.userId);
    if (!candidates.length) {
      candidates = (
        await this.db.teamMembership.findMany({
          where: { teamId: request.feature.teamId, role, userId: others },
          select: { userId: true },
        })
      ).map((m) => m.userId);
    }
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

  /** Attachment context for Choices and Spec Proposals: summaries where present, within budget. */
  private attachmentContext(featureId: string) {
    return attachmentsForAi(this.db, featureId, {
      budgetChars: ATTACHMENT_CONTEXT_BUDGET.decisionRequest,
      preferSummary: true,
    });
  }

  private async latestSpecMarkdown(featureId: string): Promise<string> {
    const latest = await this.db.specVersion.findFirst({
      where: { featureId },
      orderBy: { version: 'desc' },
      select: { markdown: true },
    });
    return latest?.markdown ?? '(This Feature has no Spec yet.)';
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
   * Decider it replaced, whose Inbox Items all change.
   */
  private async claimed(tx: Tx, outbox: Outbox, user: User, request: DecisionRequestWithRelations) {
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
