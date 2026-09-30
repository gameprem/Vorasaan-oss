import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type { DecisionLogEntry, SpecProposalView, SpecVersionView } from '@vorasaan/shared';
import { nextStatus } from '../decision-requests/decision-request.state.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import {
  type SpecProposalWithRelations,
  specProposalInclude,
  specVersionInclude,
  toSpecProposalView,
  toSpecVersionView,
} from './spec.view.ts';

/** Thrown inside the approve transaction to roll everything back. */
class StaleStateError extends Error {}

@Injectable()
export class SpecService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async getProposal(id: string): Promise<SpecProposalView> {
    return toSpecProposalView(await this.findProposalOrThrow(id));
  }

  /**
   * Turns a PENDING Spec Proposal into the next Spec Version, atomically:
   * new version + proposal APPROVED + Decision Request SPEC_UPDATED, or nothing.
   */
  async approve(user: User, id: string): Promise<SpecVersionView> {
    const proposal = await this.findPendingForApprover(user, id);

    try {
      const version = await this.db.$transaction(async (tx) => {
        const latest = await tx.specVersion.findFirst({
          where: { featureId: proposal.featureId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        });
        if ((latest?.id ?? null) !== proposal.baseVersionId) {
          throw new StaleStateError(
            'The Spec has changed since this proposal was drafted; draft a new one',
          );
        }

        const created = await tx.specVersion.create({
          data: {
            featureId: proposal.featureId,
            version: (latest?.version ?? 0) + 1,
            markdown: proposal.proposedMarkdown,
            source: proposal.source,
            approvedById: user.id,
            proposalId: proposal.id,
          },
          include: specVersionInclude,
        });

        const marked = await tx.specProposal.updateMany({
          where: { id: proposal.id, status: 'PENDING' },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        });
        if (marked.count !== 1) throw new StaleStateError('This proposal was already reviewed');

        if (proposal.decision) {
          const moved = await tx.decisionRequest.updateMany({
            where: { id: proposal.decision.requestId, status: 'DECIDED' },
            data: {
              status: nextStatus('DECIDED', 'approveSpecProposal'),
              closedAt: new Date(),
            },
          });
          if (moved.count !== 1) {
            throw new StaleStateError('The Decision Request is no longer awaiting a Spec update');
          }
        }
        return created;
      });
      return toSpecVersionView(version);
    } catch (error) {
      if (error instanceof StaleStateError) throw new ConflictException(error.message);
      throw error;
    }
  }

  /** Rejecting keeps the Decision; the Decision Request stays DECIDED. */
  async reject(user: User, id: string): Promise<SpecProposalView> {
    await this.findPendingForApprover(user, id);
    const updated = await this.db.specProposal.update({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedAt: new Date() },
      include: specProposalInclude,
    });
    return toSpecProposalView(updated);
  }

  async listVersions(featureId: string): Promise<SpecVersionView[]> {
    await this.assertFeatureExists(featureId);
    const versions = await this.db.specVersion.findMany({
      where: { featureId },
      orderBy: { version: 'desc' },
      include: specVersionInclude,
    });
    return versions.map(toSpecVersionView);
  }

  async decisionLog(featureId: string): Promise<DecisionLogEntry[]> {
    await this.assertFeatureExists(featureId);
    const person = { select: { id: true, name: true } } as const;
    const decisions = await this.db.decision.findMany({
      where: { request: { featureId } },
      orderBy: { createdAt: 'asc' },
      include: {
        request: { select: { id: true, title: true, kind: true } },
        decidedBy: person,
        onBehalfOf: person,
        choice: { select: { label: true, title: true } },
        specProposal: { select: { resultVersion: { select: { version: true } } } },
      },
    });
    return decisions.map((d) => ({
      decisionId: d.id,
      decisionRequestId: d.request.id,
      requestTitle: d.request.title,
      kind: d.request.kind,
      decidedBy: d.decidedBy,
      onBehalfOf: d.onBehalfOf,
      choice: d.choice,
      customAnswer: d.customAnswer,
      rationale: d.rationale,
      specVersion: d.specProposal?.resultVersion?.version ?? null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  private async findProposalOrThrow(id: string): Promise<SpecProposalWithRelations> {
    const proposal = await this.db.specProposal.findUnique({
      where: { id },
      include: specProposalInclude,
    });
    if (!proposal) throw new NotFoundException('Spec Proposal not found');
    return proposal;
  }

  private async findPendingForApprover(user: User, id: string) {
    const proposal = await this.findProposalOrThrow(id);
    if (proposal.approverId !== user.id) {
      throw new ForbiddenException('Only the approver can review this Spec Proposal');
    }
    if (proposal.status !== 'PENDING') {
      throw new ConflictException(`This Spec Proposal is already ${proposal.status}`);
    }
    return proposal;
  }

  private async assertFeatureExists(featureId: string) {
    const exists = await this.db.feature.count({ where: { id: featureId } });
    if (!exists) throw new NotFoundException('Feature not found');
  }
}
