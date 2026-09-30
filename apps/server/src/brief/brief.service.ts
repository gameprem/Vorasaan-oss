import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  BRIEF_TEMPLATE,
  type BriefDiff,
  type BriefProposalView,
  type BriefVersionView,
  type ProjectBriefView,
  type RevertBriefInput,
  type WriteBriefInput,
} from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { diffLines } from '../spec/diff.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import {
  briefProposalInclude,
  briefVersionInclude,
  toBriefProposalView,
  toBriefVersionView,
} from './brief.view.ts';
import { assertCanEditProject, projectAccess } from './brief-access.ts';

/** BriefVersion.version is a Postgres int4. */
const MAX_VERSION = 2_147_483_647;

/** Thrown inside a transaction to roll it back and answer 409. */
class StaleStateError extends Error {}

/**
 * The Project Brief (ADR 0006), versioned like the Spec (0020): immutable,
 * numbered Brief Versions, hand edits and reverts guarded by `baseVersion`, and
 * Brief Proposals approved or rejected by their approver. Before v1 the Brief is
 * the unsaved template, served as version 0.
 */
@Injectable()
export class BriefService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly indexing: IndexingService,
  ) {}

  async current(user: User, projectId: string): Promise<ProjectBriefView> {
    const { canEdit } = await projectAccess(this.db, user, projectId);
    const latest = await this.db.briefVersion.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      include: briefVersionInclude,
    });
    return {
      projectId,
      version: latest?.version ?? 0,
      markdown: latest?.markdown ?? BRIEF_TEMPLATE,
      current: latest ? toBriefVersionView(latest) : null,
      canEdit,
    };
  }

  async listVersions(user: User, projectId: string): Promise<BriefVersionView[]> {
    await projectAccess(this.db, user, projectId);
    const versions = await this.db.briefVersion.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
      include: briefVersionInclude,
    });
    return versions.map(toBriefVersionView);
  }

  async getVersion(user: User, projectId: string, version: number): Promise<BriefVersionView> {
    await projectAccess(this.db, user, projectId);
    return toBriefVersionView(await this.findVersionOrThrow(projectId, version));
  }

  /** `from = 0` stands for the empty Brief before v1. */
  async diff(user: User, projectId: string, from: number, to: number): Promise<BriefDiff> {
    await projectAccess(this.db, user, projectId);
    const [before, after] = await Promise.all([
      from === 0 ? '' : this.findVersionOrThrow(projectId, from).then((v) => v.markdown),
      this.findVersionOrThrow(projectId, to).then((v) => v.markdown),
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

  /** Admins and the POs of the Project's Teams write the Brief by hand. */
  async write(user: User, projectId: string, input: WriteBriefInput): Promise<BriefVersionView> {
    await assertCanEditProject(this.db, user, projectId);
    return this.saveNext(projectId, input.baseVersion, 'saving', (current) => ({
      markdown: normalizeMarkdown(input.markdown),
      source: 'MANUAL',
      summary: input.summary || (current === 0 ? 'Initial Project Brief' : 'Edited by hand'),
      approvedById: user.id,
    }));
  }

  /**
   * Restores an earlier Brief Version's Markdown as the next version. Nothing is
   * deleted: the history keeps every version, and the new one records its origin.
   */
  async revert(
    user: User,
    projectId: string,
    version: number,
    input: RevertBriefInput,
  ): Promise<BriefVersionView> {
    await assertCanEditProject(this.db, user, projectId);
    const target = await this.findVersionOrThrow(projectId, version);
    return this.saveNext(projectId, input.baseVersion, 'reverting', (current, latest) => {
      if (latest === target.markdown) {
        throw new UnprocessableEntityException(
          `v${current} already matches v${version}; there is nothing to revert`,
        );
      }
      return {
        markdown: target.markdown,
        source: 'REVERT',
        summary: input.summary || `Reverted to v${version}`,
        approvedById: user.id,
        revertedFromId: target.id,
      };
    });
  }

  async listProposals(user: User, projectId: string): Promise<BriefProposalView[]> {
    await projectAccess(this.db, user, projectId);
    const proposals = await this.db.briefProposal.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: briefProposalInclude,
    });
    return proposals.map(toBriefProposalView);
  }

  async getProposal(user: User, id: string): Promise<BriefProposalView> {
    const proposal = await this.findProposalOrThrow(id);
    await projectAccess(this.db, user, proposal.projectId);
    return toBriefProposalView(proposal);
  }

  /**
   * Turns a PENDING Brief Proposal into the next Brief Version, atomically, as
   * long as the Brief has not changed since the proposal was drafted.
   */
  async approve(user: User, id: string): Promise<BriefVersionView> {
    const proposal = await this.findPendingForApprover(user, id);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const latest = await tx.briefVersion.findFirst({
          where: { projectId: proposal.projectId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        });
        if ((latest?.id ?? null) !== proposal.baseVersionId) {
          throw new StaleStateError(
            'The Project Brief has changed since this proposal was drafted; draft a new one',
          );
        }
        const marked = await tx.briefProposal.updateMany({
          where: { id: proposal.id, status: 'PENDING' },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        });
        if (marked.count !== 1) throw new StaleStateError('This proposal was already reviewed');
        return tx.briefVersion.create({
          data: {
            projectId: proposal.projectId,
            version: (latest?.version ?? 0) + 1,
            markdown: proposal.proposedMarkdown,
            source: proposal.source,
            approvedById: user.id,
            proposalId: proposal.id,
          },
          include: briefVersionInclude,
        });
      });
      this.indexing.schedule({ source: 'BRIEF_VERSION', id: created.id });
      return toBriefVersionView(created);
    } catch (error) {
      throw conflict(error, 'Someone saved the Project Brief at the same time. Try again.');
    }
  }

  async reject(user: User, id: string): Promise<BriefProposalView> {
    await this.findPendingForApprover(user, id);
    const marked = await this.db.briefProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedAt: new Date() },
    });
    if (marked.count !== 1) throw new ConflictException('This proposal was already reviewed');
    return toBriefProposalView(await this.findProposalOrThrow(id));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Creates the next Brief Version if the Brief is still at `baseVersion`.
   * `build` gets the current version number and Markdown.
   */
  private async saveNext(
    projectId: string,
    baseVersion: number,
    action: string,
    build: (
      current: number,
      latestMarkdown: string | null,
    ) => {
      markdown: string;
      source: 'MANUAL' | 'REVERT';
      summary: string;
      approvedById: string;
      revertedFromId?: string;
    },
  ): Promise<BriefVersionView> {
    try {
      const created = await this.db.$transaction(async (tx) => {
        const latest = await tx.briefVersion.findFirst({
          where: { projectId },
          orderBy: { version: 'desc' },
          select: { version: true, markdown: true },
        });
        const current = latest?.version ?? 0;
        if (current !== baseVersion) {
          throw new StaleStateError(
            `The Project Brief is now at v${current}. Reload to see the latest before ${action}.`,
          );
        }
        return tx.briefVersion.create({
          data: { projectId, version: current + 1, ...build(current, latest?.markdown ?? null) },
          include: briefVersionInclude,
        });
      });
      this.indexing.schedule({ source: 'BRIEF_VERSION', id: created.id });
      return toBriefVersionView(created);
    } catch (error) {
      throw conflict(
        error,
        'Someone saved the Project Brief at the same time. Reload and try again.',
      );
    }
  }

  private async findProposalOrThrow(id: string) {
    const proposal = await this.db.briefProposal.findUnique({
      where: { id },
      include: briefProposalInclude,
    });
    if (!proposal) throw new NotFoundException('Brief Proposal not found');
    return proposal;
  }

  /** The named approver reviews, and only while they may still edit the Brief. */
  private async findPendingForApprover(user: User, id: string) {
    const proposal = await this.findProposalOrThrow(id);
    await assertCanEditProject(this.db, user, proposal.projectId);
    if (proposal.approverId !== user.id) {
      throw new ForbiddenException('Only the approver can review this Brief Proposal');
    }
    if (proposal.status !== 'PENDING') {
      throw new ConflictException(`This Brief Proposal is already ${proposal.status}`);
    }
    return proposal;
  }

  private async findVersionOrThrow(projectId: string, version: number) {
    // Outside the Int column's range no version can exist; Postgres would reject the query.
    if (version > MAX_VERSION) throw new NotFoundException(`Brief Version v${version} not found`);
    const found = await this.db.briefVersion.findUnique({
      where: { projectId_version: { projectId, version } },
      include: briefVersionInclude,
    });
    if (!found) throw new NotFoundException(`Brief Version v${version} not found`);
    return found;
  }
}

/** Stale state and a concurrent save (P2002 on projectId+version) are 409s; anything else is rethrown. */
function conflict(error: unknown, concurrentMessage: string): unknown {
  if (error instanceof StaleStateError) return new ConflictException(error.message);
  if ((error as { code?: string })?.code === 'P2002')
    return new ConflictException(concurrentMessage);
  return error;
}
