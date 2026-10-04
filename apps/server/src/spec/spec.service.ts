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
import {
  type DecisionLogEntry,
  diffLines,
  type RecordedModel,
  type RevertSpecInput,
  type SpecDiff,
  type SpecProposalView,
  type SpecVersionView,
} from '@vorasaan/shared';
import { AI_PORT, AiOutputError, type AiPort } from '../ai/ai.port.ts';
import { ContextBudgets } from '../ai/context-budget.ts';
import { personLanguage } from '../ai/language.ts';
import { fromRecordedModelColumns, toRecordedModelColumns } from '../ai/recorded-model.ts';
import { nextStatus } from '../decision-requests/decision-request.state.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { assertNotRedrafting, currentRedraft } from '../redrafts/redraft-guard.ts';
import { ContextRetriever, splitFeatureSpec } from '../retrieval/context-retriever.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { normalizeMarkdown } from './markdown.ts';
import {
  type SpecProposalWithRelations,
  specProposalInclude,
  specVersionInclude,
  toSpecProposalView,
  toSpecVersionView,
} from './spec.view.ts';
import { assertCanEditSpec } from './spec-access.ts';

/** SpecVersion.version is a Postgres int4. */
const MAX_VERSION = 2_147_483_647;

/** Thrown inside the approve transaction to roll everything back. */
class StaleStateError extends Error {}

@Injectable()
export class SpecService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly notifications: NotificationsService,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly indexing: IndexingService,
    private readonly retriever: ContextRetriever,
    private readonly budgets: ContextBudgets,
  ) {}

  /**
   * Asks the AI to draft the Spec from the Feature's Attachments, as a PENDING
   * Spec Proposal the requesting PO approves. The AI runs first, so a failed
   * draft writes nothing. Its context is retrieved (ADR 0007): the Feature's own
   * material and Attachments first, then related parts of the Project.
   */
  async proposeFromAttachments(user: User, featureId: string): Promise<SpecProposalView> {
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: { title: true, description: true },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    await assertCanEditSpec(this.db, user, featureId);

    const withText = await this.db.attachment.count({
      where: { featureId, AND: [{ snapshotText: { not: null } }, { snapshotText: { not: '' } }] },
    });
    if (withText === 0) {
      throw new UnprocessableEntityException(
        'This Feature has no Attachments with text to draft a Spec from',
      );
    }
    const base = await this.db.specVersion.findFirst({
      where: { featureId },
      orderBy: { version: 'desc' },
      select: { id: true, markdown: true },
    });
    // A share of the drafting model's window (0060); the current Spec is sent whole besides.
    const { model, budget } = await this.budgets.forTask(
      'draftSpecFromAttachments',
      'specFromAttachments',
      { fixed: estimateTokens(base?.markdown ?? '') },
    );
    const { context } = splitFeatureSpec(
      await this.retriever.forFeature(
        featureId,
        `${feature.title}\n\n${feature.description ?? ''}`,
        budget.context,
      ),
    );

    let draft: Awaited<ReturnType<AiPort['draftSpecFromAttachments']>>;
    try {
      draft = await this.ai.draftSpecFromAttachments(
        {
          feature: { title: feature.title, description: feature.description ?? '' },
          // The whole current Spec: it is the base the draft edits, never shortened.
          specMarkdown: base?.markdown ?? '',
          context,
        },
        { model, language: await personLanguage(this.db, user.id) },
      );
    } catch (error) {
      if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
      throw error;
    }

    const proposal = await this.db.specProposal.create({
      data: {
        featureId,
        baseVersionId: base?.id ?? null,
        source: 'AI_SUMMARY',
        proposedMarkdown: normalizeMarkdown(draft.proposedMarkdown),
        approverId: user.id,
      },
      include: specProposalInclude,
    });
    await this.notifications.publish(this.notifications.outbox().inboxChanged(user.id));
    return toSpecProposalView(proposal);
  }

  /**
   * A Spec Proposal the AI drafted in a Conversation (an Action Card, ticket
   * 0043), for the drafting PO or Admin to approve. Only someone who may edit
   * the Spec drafts one; nothing changes until it is approved.
   */
  async proposeFromConversation(
    user: User,
    featureId: string,
    input: { proposedMarkdown: string },
    draftedWith?: RecordedModel,
  ): Promise<SpecProposalView> {
    await this.assertFeatureExists(featureId);
    await assertCanEditSpec(this.db, user, featureId);
    const base = await this.db.specVersion.findFirst({
      where: { featureId },
      orderBy: { version: 'desc' },
      select: { id: true, markdown: true },
    });
    const proposedMarkdown = normalizeMarkdown(input.proposedMarkdown);
    if (base && base.markdown === proposedMarkdown) {
      throw new UnprocessableEntityException(
        'The draft is the same as the current Spec, so there is nothing to propose',
      );
    }
    const proposal = await this.db.specProposal.create({
      data: {
        featureId,
        baseVersionId: base?.id ?? null,
        source: 'CONVERSATION',
        proposedMarkdown,
        approverId: user.id,
        ...toRecordedModelColumns(draftedWith),
      },
      include: specProposalInclude,
    });
    await this.notifications.publish(this.notifications.outbox().inboxChanged(user.id));
    return toSpecProposalView(proposal);
  }

  async getProposal(id: string): Promise<SpecProposalView> {
    return toSpecProposalView(await this.findProposalOrThrow(id));
  }

  /**
   * Turns a PENDING Spec Proposal into the next Spec Version, atomically:
   * new version + proposal APPROVED + Decision Request SPEC_UPDATED, or nothing.
   * It applies the Redraft the proposal holds (0065); `redraft`, when given, must be it.
   */
  async approve(user: User, id: string, redraft?: number): Promise<SpecVersionView> {
    const found = await this.findPendingForApprover(user, id);
    // A Redraft being written is about to change it: Approve waits for it (0065).
    await assertNotRedrafting(this.db, 'SPEC_PROPOSAL', id);
    const outbox = this.notifications.outbox().inboxChanged(user.id);

    try {
      const version = await this.db.$transaction(async (tx) => {
        // Read again inside: what is approved is the Redraft the proposal holds now.
        await assertNotRedrafting(tx, 'SPEC_PROPOSAL', id);
        const current = await currentRedraft(tx, 'SPEC_PROPOSAL', id);
        if (redraft !== undefined && redraft !== current) {
          throw new StaleStateError(
            `Redraft ${current} is the current one now; review it before approving`,
          );
        }
        const proposal = await tx.specProposal.findUniqueOrThrow({
          where: { id: found.id },
          include: specProposalInclude,
        });
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
        await this.notifications.specVersionCreated(tx, outbox, created);
        return created;
      });
      await this.notifications.publish(outbox);
      this.indexing.schedule({ source: 'SPEC_VERSION', id: version.id });
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
    await this.notifications.publish(this.notifications.outbox().inboxChanged(user.id));
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

  async getVersion(featureId: string, version: number): Promise<SpecVersionView> {
    await this.assertFeatureExists(featureId);
    return toSpecVersionView(await this.findVersionOrThrow(featureId, version));
  }

  /** `from = 0` stands for the empty Spec before v1. */
  async diff(featureId: string, from: number, to: number): Promise<SpecDiff> {
    await this.assertFeatureExists(featureId);
    const [before, after] = await Promise.all([
      from === 0 ? '' : this.findVersionOrThrow(featureId, from).then((v) => v.markdown),
      this.findVersionOrThrow(featureId, to).then((v) => v.markdown),
    ]);
    const lines = diffLines(before, after);
    return {
      from,
      to,
      added: lines.filter((l) => l.kind === 'ADDED').length,
      removed: lines.filter((l) => l.kind === 'REMOVED').length,
      lines,
    };
  }

  /**
   * Restores an earlier Spec Version's Markdown as the next version. Nothing is
   * deleted: the history keeps every version, and the new one records its origin.
   */
  async revert(
    user: User,
    featureId: string,
    version: number,
    input: RevertSpecInput,
  ): Promise<SpecVersionView> {
    await this.assertFeatureExists(featureId);
    await assertCanEditSpec(this.db, user, featureId);
    const target = await this.findVersionOrThrow(featureId, version);
    const outbox = this.notifications.outbox();

    try {
      const created = await this.db.$transaction(async (tx) => {
        const latest = await tx.specVersion.findFirst({
          where: { featureId },
          orderBy: { version: 'desc' },
          select: { version: true, markdown: true },
        });
        const current = latest?.version ?? 0;
        if (current !== input.baseVersion) {
          throw new StaleStateError(
            `The Spec is now at v${current}. Reload to see the latest before reverting.`,
          );
        }
        if (latest?.markdown === target.markdown) {
          throw new UnprocessableEntityException(
            `v${current} already matches v${version}; there is nothing to revert`,
          );
        }
        const created = await tx.specVersion.create({
          data: {
            featureId,
            version: current + 1,
            markdown: target.markdown,
            source: 'REVERT',
            summary: input.summary || `Reverted to v${version}`,
            approvedById: user.id,
            revertedFromId: target.id,
          },
          include: specVersionInclude,
        });
        await this.notifications.specVersionCreated(tx, outbox, created);
        return created;
      });
      await this.notifications.publish(outbox);
      this.indexing.schedule({ source: 'SPEC_VERSION', id: created.id });
      return toSpecVersionView(created);
    } catch (error) {
      if (error instanceof StaleStateError) throw new ConflictException(error.message);
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'Someone saved the Spec at the same time. Reload and try again.',
        );
      }
      throw error;
    }
  }

  async decisionLog(featureId: string): Promise<DecisionLogEntry[]> {
    await this.assertFeatureExists(featureId);
    const person = { select: { id: true, name: true } } as const;
    const decisions = await this.db.decision.findMany({
      where: { request: { featureId } },
      orderBy: { createdAt: 'asc' },
      include: {
        request: {
          select: {
            id: true,
            title: true,
            kind: true,
            choicesApprovedModelId: true,
            choicesModelDisplayName: true,
            choicesModelName: true,
          },
        },
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
      source: d.source,
      specVersion: d.specProposal?.resultVersion?.version ?? null,
      choicesDraftedWith: fromRecordedModelColumns({
        approvedModelId: d.request.choicesApprovedModelId,
        modelDisplayName: d.request.choicesModelDisplayName,
        modelName: d.request.choicesModelName,
      }),
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

  private async findVersionOrThrow(featureId: string, version: number) {
    // Outside the Int column's range no version can exist; Postgres would reject the query.
    if (version > MAX_VERSION) throw new NotFoundException(`Spec Version v${version} not found`);
    const found = await this.db.specVersion.findUnique({
      where: { featureId_version: { featureId, version } },
      include: specVersionInclude,
    });
    if (!found) throw new NotFoundException(`Spec Version v${version} not found`);
    return found;
  }

  private async assertFeatureExists(featureId: string) {
    const exists = await this.db.feature.count({ where: { id: featureId } });
    if (!exists) throw new NotFoundException('Feature not found');
  }
}
