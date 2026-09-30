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
  DecisionRequestView,
  ListDecisionRequestsQuery,
  RaiseDecisionRequestInput,
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import { AI_PORT, AiOutputError, type AiPort } from '../ai/ai.port.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import {
  type DecisionRequestEvent,
  InvalidTransitionError,
  nextStatus,
} from './decision-request.state.ts';
import {
  type DecisionRequestWithRelations,
  decisionRequestInclude,
  toDecisionRequestView,
} from './decision-request.view.ts';

@Injectable()
export class DecisionRequestsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
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
      try {
        generated = await this.ai.generateChoices({
          specMarkdown: spec,
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
    return toDecisionRequestView(created);
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

    // Tracer-bullet routing: exactly one Role Owner of the decider role.
    // Recipient selection and Claim replace this in the MVP.
    const owners = await this.db.roleOwner.findMany({
      where: { featureId: request.featureId, role: input.deciderRole },
    });
    const [owner] = owners;
    if (!owner || owners.length !== 1) {
      throw new UnprocessableEntityException(
        `Expected exactly one ${input.deciderRole} Role Owner on this Feature, found ${owners.length}`,
      );
    }
    const deciderId = owner.userId;
    if (deciderId === request.raiserId) {
      throw new UnprocessableEntityException('The Decider cannot be the Raiser');
    }

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
        data: { status, deciderRole: input.deciderRole, deciderId, submittedAt: new Date() },
        include: decisionRequestInclude,
      });
    });
    return toDecisionRequestView(updated);
  }

  async withdraw(user: User, id: string): Promise<DecisionRequestView> {
    const request = await this.findOrThrow(id);
    this.assertRaiser(user, request);
    const status = this.transition(request, 'withdraw');
    const updated = await this.db.decisionRequest.update({
      where: { id, status: request.status },
      data: { status, closedAt: new Date() },
      include: decisionRequestInclude,
    });
    return toDecisionRequestView(updated);
  }

  async get(id: string): Promise<DecisionRequestView> {
    return toDecisionRequestView(await this.findOrThrow(id));
  }

  async list(user: User, query: ListDecisionRequestsQuery): Promise<DecisionRequestView[]> {
    const requests = await this.db.decisionRequest.findMany({
      where: {
        deciderId: query.decider === 'me' ? user.id : undefined,
        raiserId: query.raiser === 'me' ? user.id : undefined,
        status: query.status,
      },
      orderBy: { createdAt: 'desc' },
      include: decisionRequestInclude,
    });
    return requests.map(toDecisionRequestView);
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
