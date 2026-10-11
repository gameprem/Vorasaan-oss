import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  BUILT_IN_DESIGN_TEMPLATES,
  type DesignDocDetailView,
  type DesignDocProposalView,
  type DesignDocSummary,
  type DesignDocVersionView,
  type DesignDocWait,
  type DesignTemplateKind,
  DesignTemplateKind as DesignTemplateKinds,
  type DesignTemplatesView,
  designDocAffected,
  designDocWaitText,
  diffLines,
  type FeatureDesignDocsView,
  type PlatformDesignTemplate,
  platformCoverage,
  platformDesignTemplate,
  type RevertSpecInput,
  type SpecDiff,
  type TeamRole,
} from '@vorasaan/shared';
import { AI_PORT, type AiPort } from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { ContextBudgets } from '../ai/context-budget.ts';
import { projectLanguage } from '../ai/language.ts';
import { fromRecordedModelColumns, toRecordedModelColumns } from '../ai/recorded-model.ts';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { OPEN_BLOCKERS } from '../features/open-blockers.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { receiptError } from '../receipts/redact.ts';
import { assertNotRedrafting, currentRedraft } from '../redrafts/redraft-guard.ts';
import { ContextRetriever, splitFeatureSpec } from '../retrieval/context-retriever.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import {
  approversFrom,
  assertDesignDocApprover,
  designDocApprovers,
  designDocForAi,
  rolesOf,
} from './design-doc-access.ts';
import { SpecChanges } from './spec-changes.ts';

/** A draft still running after this long was abandoned (the server stopped mid-call). */
export const DESIGN_DOC_DRAFT_ABANDONED_MS = 10 * 60_000;

/** DesignDocVersion.version is a Postgres int4. */
const MAX_VERSION = 2_147_483_647;

const person = { select: { id: true, name: true } } as const;
const ordered = [{ position: 'asc' as const }, { id: 'asc' as const }];

/** Thrown inside a transaction to roll it back: what it read moved on meanwhile. */
class StaleStateError extends Error {}

/** One Design Doc a Feature should have: one per target Platform, and QA's. */
type Target = {
  /** The Platform's id, or `qa`. */
  key: string;
  platform: { id: string; name: string; roles: TeamRole[] } | null;
  name: string;
  template: DesignTemplateKind;
  /** Who approves it. */
  roles: TeamRole[];
};

type DocRow = {
  id: string;
  platformId: string | null;
  template: DesignTemplateKind;
  draftingAt: Date | null;
  draftError: string | null;
};

type VersionRow = {
  id: string;
  designDocId: string;
  version: number;
  createdAt: Date;
  specVersionId: string;
  specVersion: number;
  specMarkdown: string;
  approvedBy: { id: string; name: string };
};

type ProposalRow = {
  id: string;
  designDocId: string;
  reason: 'FIRST_DRAFT' | 'SPEC_CHANGED';
  specVersionId: string;
  specVersion: number;
  specMarkdown: string;
  createdAt: Date;
};

/** What a Feature's Design Docs are worked out from, read in a fixed number of queries. */
type Snapshot = {
  feature: { id: string; teamId: string };
  targets: Target[];
  targetNames: string[];
  latest: { id: string; version: number; markdown: string } | null;
  /** A Spec Proposal awaiting approval on the latest Spec Version. */
  pendingSpecProposal: string | null;
  /** Each target Platform's Coverage: covered or not. */
  covered: Map<string, boolean>;
  docs: Map<string, DocRow>;
  current: Map<string, VersionRow>;
  pending: Map<string, ProposalRow>;
  /** `${designDocId}:${specVersionId}` of proposals declined for that Spec Version. */
  declined: Set<string>;
  questions: Map<string, DesignDocSummary['questions']>;
  owners: { userId: string; role: TeamRole }[];
  members: { userId: string; role: TeamRole }[];
};

/**
 * Design Docs (ADR 0014, ticket 0069): one per target Platform of a Feature, and one for QA,
 * drafted by the AI from the approved Spec and approved by the Platform's people.
 *
 * - **When.** Only from a settled Spec: a Spec Version exists, no Spec Proposal on it awaits
 *   approval, and the Platform's Coverage is complete (QA: every target Platform's). Each
 *   change that may make a draft due (a new Spec Version, a declined Spec Proposal, new
 *   targets) runs `sync` in the background; a person who approves the Design Doc can also ask
 *   for the draft (after a failed or declined one).
 * - **Stale.** A Design Doc follows the Spec Version its latest version names. When a newer
 *   one changes what it covers (its own Platform's section and the general ones; everything
 *   for QA), it is stale and the AI drafts an update; a pending proposal drafted from the old
 *   Spec is superseded. Staleness is computed, never stored. A Design Doc never changes the
 *   Spec.
 * - **Questions.** What the draft needs and the Spec leaves open is raised as a Question on
 *   the Feature, a DRAFT for one of the Design Doc's Role Owners to review and send.
 * - **Approval.** Approve (a new version, with its Spec Version), Decline, and Request changes
 *   (Redrafts, RedraftsService) by the Design Doc's approvers only; others get a 403.
 *
 * AI calls run outside any transaction; what they produce is written only if what they were
 * drafted from is still current.
 */
@Injectable()
export class DesignDocsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DesignDocsService.name);
  private readonly running = new Set<Promise<unknown>>();
  /** One sync at a time per Feature: a later one waits for the one before. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    @InjectClock() private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly retriever: ContextRetriever,
    private readonly budgets: ContextBudgets,
    private readonly models: AiSettingsService,
    private readonly receipts: ReceiptsService,
    private readonly specChanges: SpecChanges,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.specChanges.listen((featureId) => this.schedule(featureId));
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  /** Waits for syncs and drafts in progress (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.running.add(promise);
    promise.then(
      () => this.running.delete(promise),
      () => this.running.delete(promise),
    );
    return promise;
  }

  /** Runs `sync` for the Feature in the background, after any sync of it already running. */
  schedule(featureId: string, requestedById: string | null = null): void {
    const before = this.chains.get(featureId) ?? Promise.resolve();
    const next = before
      .catch(() => undefined)
      .then(() => this.sync(featureId, requestedById))
      .catch((error) => this.logger.error('A Design Doc sync failed', error as Error));
    this.chains.set(featureId, next);
    void this.track(next).finally(() => {
      if (this.chains.get(featureId) === next) this.chains.delete(featureId);
    });
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** `GET /features/:id/design-docs`: everyone in the Feature's Organization. */
  async list(user: User, featureId: string): Promise<FeatureDesignDocsView> {
    await this.assertReadable(user, featureId);
    const snap = await this.snapshot(featureId);
    if (!snap) throw new NotFoundException('Feature not found');
    return {
      featureId,
      specVersion: snap.latest?.version ?? null,
      docs: snap.targets.map((t) => this.summary(snap, t, user.id)),
    };
  }

  /** `GET /features/:id/design-docs/:key`: one Design Doc, its versions and its pending proposal. */
  async detail(user: User, featureId: string, key: string): Promise<DesignDocDetailView> {
    await this.assertReadable(user, featureId);
    const snap = await this.snapshot(featureId);
    if (!snap) throw new NotFoundException('Feature not found');
    const target = this.target(snap, key);
    const doc = snap.docs.get(target.key);
    const summary = this.summary(snap, target, user.id);
    const [versions, proposal] = doc
      ? await Promise.all([
          this.db.designDocVersion.findMany({
            where: { designDocId: doc.id },
            orderBy: { version: 'desc' },
            include: versionInclude,
          }),
          summary.proposal ? this.proposalView(user, summary.proposal.id) : null,
        ])
      : [[], null];
    return { featureId, doc: summary, versions: versions.map(toVersionView), proposal };
  }

  async getProposal(user: User, id: string): Promise<DesignDocProposalView> {
    const featureId = await this.featureOfProposal(id);
    await this.assertReadable(user, featureId);
    return this.proposalView(user, id);
  }

  async diff(
    user: User,
    featureId: string,
    key: string,
    from: number,
    to: number,
  ): Promise<SpecDiff> {
    await this.assertReadable(user, featureId);
    const doc = await this.findDoc(featureId, key);
    const [before, after] = await Promise.all([
      from === 0 ? '' : this.findVersion(doc.id, from).then((v) => v.markdown),
      this.findVersion(doc.id, to).then((v) => v.markdown),
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

  // ─── Drafting ─────────────────────────────────────────────────────────────

  /**
   * Drafts every Design Doc of the Feature that is due: a first draft once its Spec is settled
   * and its Coverage complete, or an update once a new Spec Version changed what it covers. A
   * pending proposal drafted from an older Spec is superseded when the Spec changed what it
   * covers, else kept as following the latest. A Design Doc already drafting, waiting for
   * approval, or declined for the latest Spec Version is left alone.
   */
  async sync(featureId: string, requestedById: string | null = null): Promise<void> {
    const snap = await this.snapshot(featureId);
    if (!snap?.latest) return;
    const latest = snap.latest;
    const drafts: Promise<unknown>[] = [];
    for (const t of snap.targets) {
      const doc = snap.docs.get(t.key);
      let pending = doc ? snap.pending.get(doc.id) : undefined;
      if (pending && pending.specVersionId !== latest.id) {
        if (
          designDocAffected(
            pending.specMarkdown,
            latest.markdown,
            t.platform?.name ?? null,
            snap.targetNames,
          )
        ) {
          await this.db.designDocProposal.updateMany({
            where: { id: pending.id, status: 'PENDING' },
            data: { status: 'SUPERSEDED', reviewedAt: this.clock.now() },
          });
          pending = undefined;
          await this.announce(snap, t);
        } else {
          // It covers the same as before: it now follows the latest Spec Version.
          await this.db.designDocProposal.updateMany({
            where: { id: pending.id, status: 'PENDING', specVersionId: pending.specVersionId },
            data: { specVersionId: latest.id },
          });
        }
      }
      if (this.waiting(snap, t).length || pending || (doc && this.drafting(doc))) continue;
      const current = doc ? snap.current.get(doc.id) : undefined;
      if (current && !this.stale(snap, t, current)) continue;
      if (doc && snap.declined.has(`${doc.id}:${latest.id}`)) continue;
      drafts.push(
        this.startDraft(snap, t, current ? 'SPEC_CHANGED' : 'FIRST_DRAFT', requestedById).then(
          (started) => started?.done,
        ),
      );
    }
    await Promise.allSettled(drafts);
  }

  /**
   * `POST /features/:id/design-docs/:key/draft`: an approver asks for the draft now (after a
   * failed or declined one, or a change the AI wasn't told about). Answers at once with the
   * Design Doc DRAFTING; the draft is written in the background.
   */
  async requestDraft(user: User, featureId: string, key: string): Promise<DesignDocSummary> {
    await this.assertReadable(user, featureId);
    let snap = await this.snapshot(featureId);
    if (!snap) throw new NotFoundException('Feature not found');
    const t = this.target(snap, key);
    await assertDesignDocApprover(this.db, user, featureId, t.roles, 'ask for this Design Doc');
    const [wait] = this.waiting(snap, t);
    if (wait) throw new UnprocessableEntityException(designDocWaitText(t.name, wait));
    const doc = snap.docs.get(t.key);
    if (doc && this.drafting(doc)) {
      throw new ConflictException(`The ${t.name} Design Doc is being drafted. Wait for it.`);
    }
    const pending = doc ? snap.pending.get(doc.id) : undefined;
    if (pending && pending.specVersionId === snap.latest?.id) {
      throw new ConflictException(
        `A draft of the ${t.name} Design Doc waits for approval. Approve, decline or Request changes on it.`,
      );
    }
    const current = doc ? snap.current.get(doc.id) : undefined;
    if (current && !this.stale(snap, t, current) && !pending) {
      throw new ConflictException(
        `The ${t.name} Design Doc is approved and follows the latest Spec: there is nothing to draft.`,
      );
    }
    if (pending) {
      // Drafted from an older Spec: the sync supersedes or keeps it first.
      await this.sync(featureId, user.id);
      snap = (await this.snapshot(featureId)) ?? snap;
      const doc2 = snap.docs.get(t.key);
      if (doc2 && (this.drafting(doc2) || snap.pending.get(doc2.id))) {
        return this.summary(snap, t, user.id);
      }
    }
    const started = await this.startDraft(
      snap,
      t,
      current ? 'SPEC_CHANGED' : 'FIRST_DRAFT',
      user.id,
    );
    if (!started)
      throw new ConflictException(`The ${t.name} Design Doc is being drafted. Wait for it.`);
    const after = await this.snapshot(featureId);
    return this.summary(after ?? snap, t, user.id);
  }

  /**
   * Claims the Design Doc for a draft (creating its row the first time) and writes the draft
   * in the background. Null when another draft holds it.
   */
  private async startDraft(
    snap: Snapshot,
    t: Target,
    reason: 'FIRST_DRAFT' | 'SPEC_CHANGED',
    requestedById: string | null,
  ): Promise<{ done: Promise<void> } | null> {
    const featureId = snap.feature.id;
    let doc = await this.db.designDoc.findFirst({
      where: { featureId, platformId: t.platform?.id ?? null },
      select: { id: true },
    });
    if (!doc) {
      try {
        doc = await this.db.designDoc.create({
          data: { featureId, platformId: t.platform?.id ?? null, template: t.template },
          select: { id: true },
        });
      } catch (error) {
        if ((error as { code?: string })?.code !== 'P2002') throw error;
        doc = await this.db.designDoc.findFirstOrThrow({
          where: { featureId, platformId: t.platform?.id ?? null },
          select: { id: true },
        });
      }
    }
    const now = this.clock.now();
    const claimed = await this.db.designDoc.updateMany({
      where: {
        id: doc.id,
        OR: [
          { draftingAt: null },
          { draftingAt: { lt: new Date(now.getTime() - DESIGN_DOC_DRAFT_ABANDONED_MS) } },
        ],
      },
      data: { draftingAt: now, draftError: null },
    });
    if (claimed.count !== 1) return null;
    const docId = doc.id;
    const done = this.track(this.write(snap, t, docId, reason, requestedById));
    return { done };
  }

  /** Runs the AI, then stores the proposal and its questions, if the Spec is still as it was. */
  private async write(
    snap: Snapshot,
    t: Target,
    docId: string,
    reason: 'FIRST_DRAFT' | 'SPEC_CHANGED',
    requestedById: string | null,
  ): Promise<void> {
    const featureId = snap.feature.id;
    try {
      const [input, latest, current, asked] = await Promise.all([
        designDocForAi(this.db, docId),
        this.db.specVersion.findFirst({
          where: { featureId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, markdown: true },
        }),
        this.db.designDocVersion.findFirst({
          where: { designDocId: docId },
          orderBy: { version: 'desc' },
          select: { id: true, markdown: true, specVersion: { select: { markdown: true } } },
        }),
        this.db.decisionRequest.findMany({
          where: { designDocId: docId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { title: true },
        }),
      ]);
      if (!latest) throw new StaleStateError('The Feature has no Spec');
      const scope = input.scope(latest.markdown);
      const updating = reason === 'SPEC_CHANGED' && current ? current : null;
      const specChange = updating
        ? changeLines(input.scope(updating.specVersion.markdown), scope)
        : null;

      // The whole Spec part, the current Design Doc and the template are sent besides the context.
      const { model, budget } = await this.budgets.forTask('draftDesignDoc', 'decisionRequest', {
        fixed:
          estimateTokens(scope) +
          estimateTokens(updating?.markdown ?? '') +
          estimateTokens(specChange ?? '') +
          estimateTokens(input.doc.template),
      });
      const { context } = splitFeatureSpec(
        await this.retriever.forFeature(
          featureId,
          `${input.doc.name} design: ${input.feature.title}`,
          budget.context,
          { k: budget.topK },
        ),
      );

      // Chosen now, so the draft's Receipt can point at the proposal (ticket 0070).
      const proposalId = randomUUID();
      const draft = await this.ai.draftDesignDoc(
        {
          feature: input.feature,
          doc: input.doc,
          specVersion: latest.version,
          specMarkdown: scope,
          current: updating?.markdown ?? null,
          specChange,
          asked: asked.map((q) => q.title),
          context,
        },
        {
          model,
          // Written for a whole Team, not one person: the Organization's language (0068).
          language: await projectLanguage(this.db, input.projectId),
          receipt: {
            requestedById,
            output: { kind: 'DESIGN_DOC_PROPOSAL', id: proposalId },
            proposal: { kind: 'DESIGN_DOC_PROPOSAL', id: proposalId, redraft: 1 },
            featureId,
          },
        },
      );
      const recorded = await this.models.record(model);

      // Questions are raised by one of the Design Doc's Role Owners, as a DRAFT they send.
      const approvers = await designDocApprovers(this.db, featureId, t.roles);
      const raiser = [...approvers]
        .filter((a) => a.roleOwner)
        .sort((a, b) => Number(a.role === 'TECH_LEAD') - Number(b.role === 'TECH_LEAD'))[0];
      const seen = new Set(asked.map((q) => q.title.trim().toLowerCase()));
      const questions = draft.questions.filter((q) => {
        const k = q.title.trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      await this.db.$transaction(async (tx) => {
        // One after another: a transaction's queries share one connection.
        const specNow = await tx.specVersion.findFirst({
          where: { featureId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        const pendingNow = await tx.designDocProposal.count({
          where: { designDocId: docId, status: 'PENDING' },
        });
        const baseNow = await tx.designDocVersion.findFirst({
          where: { designDocId: docId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if (
          specNow?.id !== latest.id ||
          pendingNow > 0 ||
          (baseNow?.id ?? null) !== (current?.id ?? null)
        ) {
          throw new StaleStateError('What the draft was made from changed meanwhile');
        }
        await tx.designDocProposal.create({
          data: {
            id: proposalId,
            designDocId: docId,
            reason,
            specVersionId: latest.id,
            baseVersionId: current?.id ?? null,
            proposedMarkdown: normalizeMarkdown(draft.proposedMarkdown),
            summary: draft.summary,
            ...toRecordedModelColumns(recorded),
          },
        });
        if (raiser) {
          for (const q of questions) {
            await tx.decisionRequest.create({
              data: {
                featureId,
                kind: 'QUESTION',
                withChoices: false,
                raiserId: raiser.userId,
                title: q.title.slice(0, 200),
                description: `${q.description || q.title}\n\nFound while drafting the ${input.doc.name} Design Doc from Spec v${latest.version}.`,
                deciderRole: 'PO',
                designDocId: docId,
              },
            });
          }
        }
        await tx.designDoc.update({
          where: { id: docId },
          data: { draftingAt: null, draftError: null },
        });
      });
      await this.notifications.publish(
        this.notifications.outbox().inboxChanged(
          approvers.map((a) => a.userId),
          raiser?.userId,
        ),
      );
    } catch (error) {
      await this.db.designDoc
        .updateMany({
          where: { id: docId },
          data: {
            draftingAt: null,
            draftError: error instanceof StaleStateError ? null : receiptError(error).slice(0, 300),
          },
        })
        .catch(() => undefined);
      if (error instanceof StaleStateError) {
        // A newer Spec (or proposal) arrived while drafting: draft again from what is current.
        this.schedule(featureId, requestedById);
        return;
      }
      this.logger.warn(`A Design Doc draft failed: ${(error as Error)?.message}`);
      await this.announce(snap, t);
    }
  }

  // ─── Approval ─────────────────────────────────────────────────────────────

  /**
   * Turns a PENDING proposal into the Design Doc's next version, following the Spec Version it
   * was drafted from, which must still be the latest. It applies the Redraft the proposal holds
   * (0065); `redraft`, when given, must be it.
   */
  async approve(user: User, id: string, redraft?: number): Promise<DesignDocVersionView> {
    const found = await this.findPendingForReviewer(user, id, 'approve');
    await assertNotRedrafting(this.db, 'DESIGN_DOC_PROPOSAL', id);
    let approvedRedraft = 1;
    try {
      const version = await this.db.$transaction(async (tx) => {
        await assertNotRedrafting(tx, 'DESIGN_DOC_PROPOSAL', id);
        approvedRedraft = await currentRedraft(tx, 'DESIGN_DOC_PROPOSAL', id);
        if (redraft !== undefined && redraft !== approvedRedraft) {
          throw new StaleStateError(
            `Redraft ${approvedRedraft} is the current one now; review it before approving`,
          );
        }
        const proposal = await tx.designDocProposal.findUniqueOrThrow({ where: { id } });
        const spec = await tx.specVersion.findFirst({
          where: { featureId: found.featureId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        const latest = await tx.designDocVersion.findFirst({
          where: { designDocId: proposal.designDocId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        });
        if (spec?.id !== proposal.specVersionId) {
          throw new StaleStateError(
            'The Spec has changed since this Design Doc was drafted; an update is drafted from the new Spec',
          );
        }
        if ((latest?.id ?? null) !== proposal.baseVersionId) {
          throw new StaleStateError('The Design Doc has changed since this was drafted');
        }
        const created = await tx.designDocVersion.create({
          data: {
            designDocId: proposal.designDocId,
            version: (latest?.version ?? 0) + 1,
            markdown: proposal.proposedMarkdown,
            source: 'AI_DRAFT',
            summary: proposal.summary,
            specVersionId: proposal.specVersionId,
            approvedById: user.id,
            proposalId: proposal.id,
          },
          include: versionInclude,
        });
        const marked = await tx.designDocProposal.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', reviewedById: user.id, reviewedAt: this.clock.now() },
        });
        if (marked.count !== 1) throw new StaleStateError('This proposal was already reviewed');
        return created;
      });
      await this.notifyApprovers(found.featureId, found.roles, user.id);
      this.receipts.outcome({
        kind: 'APPROVE',
        proposal: { kind: 'DESIGN_DOC_PROPOSAL', id },
        actorId: user.id,
        redraft: approvedRedraft,
      });
      return toVersionView(version);
    } catch (error) {
      if (error instanceof StaleStateError) throw new ConflictException(error.message);
      throw error;
    }
  }

  /** Declines a PENDING proposal; the AI doesn't draft that Design Doc again for this Spec Version. */
  async decline(user: User, id: string, reason?: string): Promise<DesignDocProposalView> {
    const found = await this.findPendingForReviewer(user, id, 'decline');
    const redraft = await currentRedraft(this.db, 'DESIGN_DOC_PROPOSAL', id);
    const marked = await this.db.designDocProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'DECLINED',
        reviewedById: user.id,
        reviewedAt: this.clock.now(),
        declineReason: reason?.trim() || null,
      },
    });
    if (marked.count !== 1) throw new ConflictException('This proposal was already reviewed');
    await this.notifyApprovers(found.featureId, found.roles, user.id);
    this.receipts.outcome({
      kind: 'DECLINE',
      proposal: { kind: 'DESIGN_DOC_PROPOSAL', id },
      actorId: user.id,
      redraft,
      reason: reason ?? null,
    });
    return this.proposalView(user, id);
  }

  /**
   * Restores an earlier version as the next one (it follows the Spec Version the restored one
   * did). Nothing is deleted. If that makes the Design Doc stale, the AI proposes an update.
   */
  async revert(
    user: User,
    featureId: string,
    key: string,
    version: number,
    input: RevertSpecInput,
  ): Promise<DesignDocVersionView> {
    await this.assertReadable(user, featureId);
    const doc = await this.findDoc(featureId, key);
    const roles = rolesOf(doc.platform);
    await assertDesignDocApprover(this.db, user, featureId, roles, 'revert this Design Doc');
    const target = await this.findVersion(doc.id, version);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const latest = await tx.designDocVersion.findFirst({
          where: { designDocId: doc.id },
          orderBy: { version: 'desc' },
          select: { version: true, markdown: true, specVersionId: true },
        });
        const current = latest?.version ?? 0;
        if (current !== input.baseVersion) {
          throw new StaleStateError(
            `The Design Doc is now at v${current}. Reload to see the latest before reverting.`,
          );
        }
        if (latest?.markdown === target.markdown && latest.specVersionId === target.specVersionId) {
          throw new UnprocessableEntityException(
            `v${current} already matches v${version}; there is nothing to revert`,
          );
        }
        return tx.designDocVersion.create({
          data: {
            designDocId: doc.id,
            version: current + 1,
            markdown: target.markdown,
            source: 'REVERT',
            summary: input.summary || `Reverted to v${version}`,
            specVersionId: target.specVersionId,
            approvedById: user.id,
            revertedFromId: target.id,
          },
          include: versionInclude,
        });
      });
      this.schedule(featureId, user.id);
      return toVersionView(created);
    } catch (error) {
      if (error instanceof StaleStateError) throw new ConflictException(error.message);
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'Someone changed the Design Doc at the same time. Reload and try again.',
        );
      }
      throw error;
    }
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  /** `GET /projects/:id/design-templates`: everyone in the Organization reads them. */
  async templates(user: User, projectId: string): Promise<DesignTemplatesView> {
    const { canEdit } = await projectAccess(this.db, user, projectId);
    const own = await this.db.designTemplate.findMany({
      where: { projectId },
      select: { kind: true, markdown: true },
    });
    const byKind = new Map(own.map((t) => [t.kind, t.markdown]));
    return {
      projectId,
      canEdit,
      templates: DesignTemplateKinds.options.map((kind) => ({
        kind,
        markdown: byKind.get(kind) ?? BUILT_IN_DESIGN_TEMPLATES[kind],
        builtIn: !byKind.has(kind),
      })),
    };
  }

  /** Admins and the POs of the Project's Teams replace one template; drafts after it use it. */
  async setTemplate(
    user: User,
    projectId: string,
    kind: DesignTemplateKind,
    markdown: string | null,
  ): Promise<DesignTemplatesView> {
    await assertCanEditProject(this.db, user, projectId);
    if (markdown === null) {
      await this.db.designTemplate.deleteMany({ where: { projectId, kind } });
    } else {
      const text = normalizeMarkdown(markdown);
      await this.db.designTemplate.upsert({
        where: { projectId_kind: { projectId, kind } },
        create: { projectId, kind, markdown: text, updatedById: user.id },
        update: { markdown: text, updatedById: user.id },
      });
    }
    return this.templates(user, projectId);
  }

  // ─── The rules ────────────────────────────────────────────────────────────

  /** Why the Design Doc can't be drafted now; empty when it can. */
  private waiting(snap: Snapshot, t: Target): DesignDocWait[] {
    if (!snap.latest) return [{ kind: 'NO_SPEC' }];
    const out: DesignDocWait[] = [];
    if (snap.pendingSpecProposal) {
      out.push({ kind: 'SPEC_PROPOSAL_PENDING', proposalId: snap.pendingSpecProposal });
    }
    if (t.platform) {
      if (!snap.covered.get(t.platform.id)) out.push({ kind: 'COVERAGE_MISSING' });
    } else {
      const platforms = snap.targets.flatMap((x) => (x.platform ? [x.platform] : []));
      if (platforms.length === 0) out.push({ kind: 'NO_TARGETS' });
      const uncovered = platforms.filter((p) => !snap.covered.get(p.id));
      if (uncovered.length) {
        out.push({
          kind: 'PLATFORMS_NOT_COVERED',
          platforms: uncovered.map((p) => ({ id: p.id, name: p.name })),
        });
      }
    }
    return out;
  }

  /** Whether the latest Spec changed what the Design Doc's latest version covers. */
  private stale(snap: Snapshot, t: Target, current: VersionRow): boolean {
    if (!snap.latest || current.specVersionId === snap.latest.id) return false;
    return designDocAffected(
      current.specMarkdown,
      snap.latest.markdown,
      t.platform?.name ?? null,
      snap.targetNames,
    );
  }

  private drafting(doc: DocRow): boolean {
    return (
      doc.draftingAt !== null &&
      doc.draftingAt.getTime() > this.clock.now().getTime() - DESIGN_DOC_DRAFT_ABANDONED_MS
    );
  }

  private summary(snap: Snapshot, t: Target, viewerId: string): DesignDocSummary {
    const doc = snap.docs.get(t.key);
    const current = doc ? snap.current.get(doc.id) : undefined;
    const pending = doc ? snap.pending.get(doc.id) : undefined;
    const waiting = this.waiting(snap, t);
    const stale = current ? this.stale(snap, t, current) : false;
    const state: DesignDocSummary['state'] =
      doc && this.drafting(doc)
        ? 'DRAFTING'
        : current
          ? stale
            ? 'STALE'
            : 'APPROVED'
          : pending
            ? 'PROPOSED'
            : waiting.length
              ? 'WAITING'
              : 'READY';
    const approvers = approversFrom(t.roles, snap.owners, snap.members);
    return {
      key: t.key,
      platform: t.platform ? { id: t.platform.id, name: t.platform.name } : null,
      name: t.name,
      template: doc?.template ?? t.template,
      state,
      waiting,
      current: current
        ? {
            version: current.version,
            specVersion: current.specVersion,
            approvedBy: current.approvedBy,
            createdAt: current.createdAt.toISOString(),
          }
        : null,
      proposal: pending
        ? {
            id: pending.id,
            reason: pending.reason,
            specVersion: pending.specVersion,
            createdAt: pending.createdAt.toISOString(),
          }
        : null,
      draftError: doc?.draftError ?? null,
      canApprove: approvers.some((a) => a.userId === viewerId),
      approverRoles: t.roles,
      questions: doc ? (snap.questions.get(doc.id) ?? []) : [],
    };
  }

  private target(snap: Snapshot, key: string): Target {
    const t = snap.targets.find((x) => x.key === key);
    if (!t) throw new NotFoundException('This Feature has no such Design Doc');
    return t;
  }

  /**
   * Everything the Design Docs of a Feature are worked out from, in two rounds of queries run
   * together, however many Design Docs, versions and questions it has.
   */
  private async snapshot(featureId: string): Promise<Snapshot | null> {
    const [feature, platforms, latest, specProposals, docs, owners, members, blockers] =
      await Promise.all([
        this.db.feature.findUnique({
          where: { id: featureId },
          select: { id: true, teamId: true },
        }),
        this.db.platform.findMany({
          where: { features: { some: { featureId } } },
          orderBy: ordered,
          select: {
            id: true,
            name: true,
            roles: true,
            specSection: true,
            someoneToAsk: true,
            noOpenBlockers: true,
            qaReady: true,
            designTemplate: true,
          },
        }),
        this.db.specVersion.findFirst({
          where: { featureId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, markdown: true },
        }),
        this.db.specProposal.findMany({
          where: { featureId, status: 'PENDING' },
          select: { id: true, baseVersionId: true },
        }),
        this.db.designDoc.findMany({
          where: { featureId },
          select: {
            id: true,
            platformId: true,
            template: true,
            draftingAt: true,
            draftError: true,
          },
        }),
        this.db.roleOwner.findMany({ where: { featureId }, select: { userId: true, role: true } }),
        this.db.teamMembership.findMany({
          where: { team: { features: { some: { id: featureId } } } },
          select: { userId: true, role: true },
        }),
        this.db.decisionRequest.findMany({
          where: { featureId, ...OPEN_BLOCKERS.where },
          select: {
            id: true,
            title: true,
            choices: { select: { title: true, description: true }, orderBy: { position: 'asc' } },
          },
        }),
      ]);
    if (!feature) return null;

    const docIds = docs.map((d) => d.id);
    const [versions, proposals, declined, questions] = docIds.length
      ? await Promise.all([
          // The latest version of each Design Doc, with the Spec Version it follows.
          this.db.$queryRaw<
            {
              id: string;
              designDocId: string;
              version: number;
              createdAt: Date;
              specVersionId: string;
              specVersion: number;
              specMarkdown: string;
              approvedById: string;
              approvedByName: string;
            }[]
          >`
            SELECT DISTINCT ON (v."designDocId") v.id, v."designDocId", v.version, v."createdAt",
                   v."specVersionId", s.version AS "specVersion", s.markdown AS "specMarkdown",
                   u.id AS "approvedById", u.name AS "approvedByName"
            FROM "DesignDocVersion" v
            JOIN "SpecVersion" s ON s.id = v."specVersionId"
            JOIN "User" u ON u.id = v."approvedById"
            WHERE v."designDocId" = ANY(${docIds}::text[])
            ORDER BY v."designDocId", v.version DESC`,
          this.db.$queryRaw<
            {
              id: string;
              designDocId: string;
              reason: 'FIRST_DRAFT' | 'SPEC_CHANGED';
              specVersionId: string;
              specVersion: number;
              specMarkdown: string;
              createdAt: Date;
            }[]
          >`
            SELECT p.id, p."designDocId", p.reason::text AS reason, p."specVersionId",
                   s.version AS "specVersion", s.markdown AS "specMarkdown", p."createdAt"
            FROM "DesignDocProposal" p
            JOIN "SpecVersion" s ON s.id = p."specVersionId"
            WHERE p."designDocId" = ANY(${docIds}::text[]) AND p.status = 'PENDING'`,
          this.db.designDocProposal.findMany({
            where: { designDocId: { in: docIds }, status: 'DECLINED' },
            select: { designDocId: true, specVersionId: true },
          }),
          this.db.$queryRaw<
            {
              id: string;
              designDocId: string;
              title: string;
              status: DesignDocSummary['questions'][number]['status'];
              raiserId: string;
              raiserName: string;
              createdAt: Date;
            }[]
          >`
            SELECT r.id, r."designDocId", r.title, r.status::text AS status,
                   u.id AS "raiserId", u.name AS "raiserName", r."createdAt"
            FROM "DecisionRequest" r
            JOIN "User" u ON u.id = r."raiserId"
            WHERE r."designDocId" = ANY(${docIds}::text[])`,
        ])
      : [[], [], [], []];

    const teamRoles = new Set(members.map((m) => m.role));
    const openBlockers = blockers.map((b) => ({
      id: b.id,
      title: b.title,
      choices: b.choices.flatMap((c) => [c.title, c.description]),
    }));
    const covered = new Map(
      platforms.map((p) => [
        p.id,
        platformCoverage({
          platform: p,
          specMarkdown: latest?.markdown ?? null,
          teamRoles,
          openBlockers,
        }).covered,
      ]),
    );
    const targets: Target[] = [
      ...platforms.map(
        (p): Target => ({
          key: p.id,
          platform: { id: p.id, name: p.name, roles: p.roles },
          name: p.name,
          template: platformDesignTemplate({
            designTemplate:
              p.designTemplate === 'QA'
                ? null
                : (p.designTemplate as PlatformDesignTemplate | null),
            roles: p.roles,
          }),
          roles: rolesOf(p),
        }),
      ),
      { key: 'qa', platform: null, name: 'QA', template: 'QA', roles: rolesOf(null) },
    ];
    const byKey = new Map<string, DocRow>();
    for (const d of docs) byKey.set(d.platformId ?? 'qa', d);
    const questionsOf = new Map<string, DesignDocSummary['questions']>();
    // Oldest first, sorted here: never by the database's text order.
    for (const q of [...questions].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    )) {
      questionsOf.set(q.designDocId, [
        ...(questionsOf.get(q.designDocId) ?? []),
        {
          id: q.id,
          title: q.title,
          status: q.status,
          raiser: { id: q.raiserId, name: q.raiserName },
        },
      ]);
    }
    return {
      feature,
      targets,
      targetNames: platforms.map((p) => p.name),
      latest,
      pendingSpecProposal:
        specProposals.find((p) => (p.baseVersionId ?? null) === (latest?.id ?? null))?.id ?? null,
      covered,
      docs: byKey,
      current: new Map(
        versions.map((v) => [
          v.designDocId,
          {
            id: v.id,
            designDocId: v.designDocId,
            version: v.version,
            createdAt: v.createdAt,
            specVersionId: v.specVersionId,
            specVersion: v.specVersion,
            specMarkdown: v.specMarkdown,
            approvedBy: { id: v.approvedById, name: v.approvedByName },
          },
        ]),
      ),
      pending: new Map(proposals.map((p) => [p.designDocId, p])),
      declined: new Set(declined.map((d) => `${d.designDocId}:${d.specVersionId}`)),
      questions: questionsOf,
      owners,
      members,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async proposalView(user: User, id: string): Promise<DesignDocProposalView> {
    const p = await this.db.designDocProposal.findUnique({
      where: { id },
      include: {
        specVersion: { select: { version: true } },
        baseVersion: { select: { version: true, markdown: true } },
        reviewedBy: person,
        designDoc: {
          select: {
            featureId: true,
            platformId: true,
            platform: { select: { id: true, name: true, roles: true } },
          },
        },
      },
    });
    if (!p) throw new NotFoundException('Design Doc proposal not found');
    const roles = rolesOf(p.designDoc.platform);
    const approvers = await designDocApprovers(this.db, p.designDoc.featureId, roles);
    return {
      id: p.id,
      featureId: p.designDoc.featureId,
      key: p.designDoc.platformId ?? 'qa',
      platform: p.designDoc.platform
        ? { id: p.designDoc.platform.id, name: p.designDoc.platform.name }
        : null,
      name: p.designDoc.platform?.name ?? 'QA',
      status: p.status,
      reason: p.reason,
      specVersion: p.specVersion.version,
      baseVersion: p.baseVersion?.version ?? null,
      baseMarkdown: p.baseVersion?.markdown ?? '',
      proposedMarkdown: p.proposedMarkdown,
      summary: p.summary,
      reviewedBy: p.reviewedBy,
      declineReason: p.declineReason,
      draftedWith: fromRecordedModelColumns(p),
      canReview: p.status === 'PENDING' && approvers.some((a) => a.userId === user.id),
      createdAt: p.createdAt.toISOString(),
    };
  }

  private async findPendingForReviewer(user: User, id: string, what: 'approve' | 'decline') {
    const p = await this.db.designDocProposal.findUnique({
      where: { id },
      select: {
        status: true,
        designDoc: {
          select: { featureId: true, platform: { select: { roles: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException('Design Doc proposal not found');
    const roles = rolesOf(p.designDoc.platform);
    await assertDesignDocApprover(
      this.db,
      user,
      p.designDoc.featureId,
      roles,
      `${what} this Design Doc`,
    );
    if (p.status !== 'PENDING') {
      throw new ConflictException(`This Design Doc proposal is already ${p.status.toLowerCase()}`);
    }
    return { featureId: p.designDoc.featureId, roles };
  }

  private async featureOfProposal(id: string): Promise<string> {
    const p = await this.db.designDocProposal.findUnique({
      where: { id },
      select: { designDoc: { select: { featureId: true } } },
    });
    if (!p) throw new NotFoundException('Design Doc proposal not found');
    return p.designDoc.featureId;
  }

  private async findDoc(featureId: string, key: string) {
    const doc = await this.db.designDoc.findFirst({
      where: { featureId, platformId: key === 'qa' ? null : key },
      select: { id: true, platform: { select: { roles: true } } },
    });
    if (!doc) throw new NotFoundException('This Design Doc has no versions yet');
    return doc;
  }

  private async findVersion(designDocId: string, version: number) {
    if (version > MAX_VERSION) throw new NotFoundException(`Design Doc v${version} not found`);
    const found = await this.db.designDocVersion.findUnique({
      where: { designDocId_version: { designDocId, version } },
      select: { id: true, markdown: true, specVersionId: true },
    });
    if (!found) throw new NotFoundException(`Design Doc v${version} not found`);
    return found;
  }

  /** Everyone in the Feature's Organization reads its Design Docs; anyone else gets a 404. */
  private async assertReadable(user: User, featureId: string) {
    const feature = await this.db.feature.count({
      where: {
        id: featureId,
        team: { project: { organization: { memberships: { some: { userId: user.id } } } } },
      },
    });
    if (!feature) throw new NotFoundException('Feature not found');
  }

  /** Whoever approves the Design Doc sees it change (their Inbox and the Feature page refresh). */
  private async announce(snap: Snapshot, t: Target) {
    const approvers = approversFrom(t.roles, snap.owners, snap.members);
    await this.notifications.publish(
      this.notifications.outbox().inboxChanged(approvers.map((a) => a.userId)),
    );
  }

  private async notifyApprovers(featureId: string, roles: TeamRole[], actorId: string) {
    const approvers = await designDocApprovers(this.db, featureId, roles);
    await this.notifications.publish(
      this.notifications.outbox().inboxChanged(
        approvers.map((a) => a.userId),
        actorId,
      ),
    );
  }
}

const versionInclude = {
  approvedBy: person,
  revertedFrom: { select: { version: true } },
  specVersion: { select: { version: true } },
  proposal: { select: { approvedModelId: true, modelDisplayName: true, modelName: true } },
} satisfies Prisma.DesignDocVersionInclude;

function toVersionView(
  v: Prisma.DesignDocVersionGetPayload<{ include: typeof versionInclude }>,
): DesignDocVersionView {
  return {
    id: v.id,
    version: v.version,
    markdown: v.markdown,
    source: v.source,
    summary: v.summary,
    specVersion: v.specVersion.version,
    approvedBy: v.approvedBy,
    revertedFrom: v.revertedFrom?.version ?? null,
    draftedWith: fromRecordedModelColumns(v.proposal),
    createdAt: v.createdAt.toISOString(),
  };
}

/** What a Spec change did to what a Design Doc covers, as "- removed" and "+ added" lines. */
export function changeLines(before: string, after: string): string {
  const changed = diffLines(before, after)
    .filter((l) => l.kind !== 'UNCHANGED' && l.text.trim())
    .slice(0, 200)
    .map((l) => `${l.kind === 'ADDED' ? '+' : '-'} ${l.text}`);
  return changed.length ? changed.join('\n') : '(Only whitespace changed.)';
}
