import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  type AcceptFeatureSuggestionInput,
  type AcceptFeatureSuggestionResult,
  DEFAULT_FEATURE_SUGGESTIONS,
  type DismissFeatureSuggestionInput,
  type FeatureFitInput,
  type FeatureFitView,
  type FeatureSuggestionView,
  type GenerateFeatureSuggestionsInput,
  type GuidelineFitView,
  type ListFeatureSuggestionsQuery,
  MAX_FEATURE_SUGGESTIONS,
} from '@vorasaan/shared';
import { AI_PORT, AiOutputError, type AiPort, type ContextBlock } from '../ai/ai.port.ts';
import { ContextBudgets, projectBudget } from '../ai/context-budget.ts';
import { clipForAi } from '../attachments/attachment-context.ts';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import {
  ProjectFoundation,
  type ReferencedGuideline,
} from '../feature-guidelines/project-foundation.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ContextRetriever } from '../retrieval/context-retriever.ts';
import { decisionText } from '../retrieval/source-text.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import { specProposalInclude, toSpecProposalView } from '../spec/spec.view.ts';
import { featureSuggestionInclude, toFeatureSuggestionView } from './feature-suggestion.view.ts';

/** What generation retrieves the Project's context for. */
const SUGGEST_QUERY =
  'business goals KPIs target users current capabilities missing features gaps constraints non-goals';
/** The Decision Log highlights sent to the AI: this many recent Decisions... */
const RECENT_DECISIONS = 15;
/** ...each shortened to this many characters. */
const DECISION_CHARS = 1_200;
/** The dismissed suggestions sent back to the AI, newest first. */
const DISMISSED_FOR_AI = 30;
const DISMISSED_RATIONALE_CHARS = 500;
/** A one-line fit reason, at most this long. */
const MAX_REASON_CHARS = 300;

/**
 * Feature Suggestions and the Feature Guidelines fit check (ticket 0034,
 * REQUIREMENT §3.8). The AI proposes Features from the Project Brief, the
 * effective Guidelines, the Project's existing Features, Specs and Attachments
 * (capability gaps), the Decision Log and what POs dismissed before, with why.
 * A PO accepts one (a DRAFT Feature with an AI-drafted Spec Proposal) or
 * dismisses it with a reason.
 *
 * Like Grilling, every AI call comes first; its result is written in one
 * transaction after. A failed AI call is a 502 and writes nothing.
 */
@Injectable()
export class FeatureSuggestionsService {
  private readonly logger = new Logger(FeatureSuggestionsService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly notifications: NotificationsService,
    private readonly budgets: ContextBudgets,
  ) {}

  /** The Project's POs and Admins ask for up to `count` (default 5, at most 10) new suggestions. */
  async generate(
    user: User,
    projectId: string,
    input: GenerateFeatureSuggestionsInput,
  ): Promise<FeatureSuggestionView[]> {
    await assertCanEditProject(this.db, user, projectId);
    const count = Math.min(input?.count ?? DEFAULT_FEATURE_SUGGESTIONS, MAX_FEATURE_SUGGESTIONS);
    const project = await this.db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true },
    });
    const { model, budget } = await this.budgets.forTask('suggestFeatures', 'featureSuggestions');
    const [guidelines, projectContext, decisions, earlier, features] = await Promise.all([
      this.foundation.referencedGuidelines(projectId),
      this.retriever.forProject(
        projectId,
        `${project.name}\n${SUGGEST_QUERY}`,
        projectBudget(budget),
      ),
      this.decisionLog(projectId),
      this.db.featureSuggestion.findMany({
        where: { projectId, status: { in: ['PENDING', 'DISMISSED'] } },
        orderBy: [{ decidedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: { title: true, rationale: true, status: true, dismissReason: true },
      }),
      this.db.feature.findMany({ where: { team: { projectId } }, select: { title: true } }),
    ]);
    const dismissed = earlier
      .filter((s) => s.status === 'DISMISSED')
      .slice(0, DISMISSED_FOR_AI)
      .map((s) => ({
        title: s.title,
        rationale: clipForAi(s.rationale, DISMISSED_RATIONALE_CHARS),
        reason: s.dismissReason ?? '',
      }));
    const pending = earlier.filter((s) => s.status === 'PENDING').map((s) => s.title);

    const drafted = await this.callAi(() =>
      this.ai.suggestFeatures(
        {
          project: { name: project.name },
          count,
          projectContext,
          guidelines: guidelines.map(({ criterion: _, ...g }) => g),
          decisions,
          dismissed,
          pending,
        },
        { model },
      ),
    );

    // Never the same title twice, nor one that exists, waits or was dismissed.
    const taken = new Set(
      [...earlier.map((s) => s.title), ...features.map((f) => f.title)].map(titleKey),
    );
    const byRef = new Map(guidelines.map((g) => [g.ref, g.criterion.id]));
    const fresh = drafted.suggestions
      .filter((s) => {
        const key = titleKey(s.title);
        if (taken.has(key)) return false;
        taken.add(key);
        return true;
      })
      .slice(0, count);

    const batchId = randomUUID();
    const ids = fresh.map(() => randomUUID());
    const now = Date.now();
    await this.db.$transaction(async (tx) => {
      await tx.featureSuggestion.createMany({
        data: fresh.map((s, i) => ({
          id: ids[i] as string,
          projectId,
          batchId,
          title: s.title,
          rationale: s.rationale,
          businessValue: s.businessValue,
          effort: s.effort,
          risk: s.risk,
          // Only Guidelines the AI was given, each once.
          servesGuidelineIds: [
            ...new Set(s.servesGuidelines.flatMap((ref) => byRef.get(ref.trim()) ?? [])),
          ],
          generatedById: user.id,
          // Keeps the AI's order (most valuable first) in `createdAt desc, id` listings.
          createdAt: new Date(now - i),
        })),
      });
    });
    const created = await this.db.featureSuggestion.findMany({
      where: { id: { in: ids } },
      include: featureSuggestionInclude,
    });
    const byId = new Map(created.map((s) => [s.id, s]));
    return ids.flatMap((id) => {
      const s = byId.get(id);
      return s ? [toFeatureSuggestionView(s)] : [];
    });
  }

  /** Everyone in the Project's Organization reads them, newest first. */
  async list(
    user: User,
    projectId: string,
    query: ListFeatureSuggestionsQuery,
  ): Promise<FeatureSuggestionView[]> {
    await projectAccess(this.db, user, projectId);
    const suggestions = await this.db.featureSuggestion.findMany({
      where: { projectId, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: featureSuggestionInclude,
    });
    return suggestions.map(toFeatureSuggestionView);
  }

  /**
   * A PO of the chosen Team (one of the suggestion's Project's Teams) or an Admin
   * accepts: a DRAFT Feature in that Team and the first Spec drafted by the AI
   * as a PENDING Spec Proposal for the accepter to approve. The accepter becomes
   * the Feature's PO Role Owner only if they hold the PO Team Role in that Team
   * (Role Owners are always Team members, 0012); an Admin outside the Team
   * leaves the Feature with no Role Owner, to be set later.
   */
  async accept(
    user: User,
    id: string,
    input: AcceptFeatureSuggestionInput,
  ): Promise<AcceptFeatureSuggestionResult> {
    const suggestion = await this.findOrThrow(id);
    const access = await projectAccess(this.db, user, suggestion.projectId);
    const team = await this.db.team.findUnique({
      where: { id: input.teamId },
      select: { id: true, projectId: true },
    });
    if (!team || team.projectId !== suggestion.projectId) {
      throw new UnprocessableEntityException("The Team must be one of this Project's Teams");
    }
    const isTeamPo =
      (await this.db.teamMembership.count({
        where: { teamId: team.id, userId: user.id, role: 'PO' },
      })) > 0;
    if (!isTeamPo && !access.isAdmin) {
      throw new ForbiddenException("Only an Admin or this Team's PO can accept it");
    }
    if (suggestion.status !== 'PENDING') throw alreadyDecided(suggestion.status);

    const project = await this.db.project.findUniqueOrThrow({
      where: { id: suggestion.projectId },
      select: { name: true },
    });
    const { model, budget } = await this.budgets.forTask(
      'draftSpecFromSuggestion',
      'featureSuggestions',
    );
    const [guidelines, projectContext] = await Promise.all([
      this.foundation.referencedGuidelines(suggestion.projectId),
      this.retriever.forProject(
        suggestion.projectId,
        `${suggestion.title}\n\n${suggestion.rationale}\n\n${suggestion.businessValue}`,
        projectBudget(budget),
      ),
    ]);
    const draft = await this.callAi(() =>
      this.ai.draftSpecFromSuggestion(
        {
          project: { name: project.name },
          suggestion: {
            title: suggestion.title,
            rationale: suggestion.rationale,
            businessValue: suggestion.businessValue,
            effort: suggestion.effort,
            risk: suggestion.risk,
          },
          projectContext,
          guidelines: guidelines.map(({ ref: _, criterion: __, ...g }) => g),
        },
        { model },
      ),
    );

    const { feature, proposal } = await this.db.$transaction(async (tx) => {
      // Waits for a concurrent accept or dismiss, then finds it no longer PENDING.
      const decided = await tx.featureSuggestion.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'ACCEPTED', decidedById: user.id, decidedAt: new Date() },
      });
      if (decided.count !== 1) throw alreadyDecided();
      const feature = await tx.feature.create({
        data: {
          teamId: team.id,
          title: suggestion.title,
          description: suggestion.rationale,
          status: 'DRAFT',
          ...(isTeamPo ? { roleOwners: { create: { userId: user.id, role: 'PO' } } } : {}),
        },
        select: { id: true, teamId: true, title: true, status: true },
      });
      await tx.featureSuggestion.update({ where: { id }, data: { featureId: feature.id } });
      const proposal = await tx.specProposal.create({
        data: {
          featureId: feature.id,
          baseVersionId: null,
          source: 'AI_SUMMARY',
          proposedMarkdown: normalizeMarkdown(draft.proposedMarkdown),
          approverId: user.id,
        },
        include: specProposalInclude,
      });
      return { feature, proposal };
    });
    // The Spec Proposal waits in the accepter's Inbox.
    await this.notifications.publish(this.notifications.outbox().inboxChanged(user.id));
    return {
      suggestion: toFeatureSuggestionView(await this.findOrThrow(id)),
      feature,
      proposal: toSpecProposalView(proposal),
    };
  }

  /** The Project's POs and Admins dismiss a PENDING suggestion, saying why. */
  async dismiss(
    user: User,
    id: string,
    input: DismissFeatureSuggestionInput,
  ): Promise<FeatureSuggestionView> {
    const suggestion = await this.findOrThrow(id);
    await assertCanEditProject(this.db, user, suggestion.projectId);
    const decided = await this.db.featureSuggestion.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'DISMISSED',
        dismissReason: input.reason,
        decidedById: user.id,
        decidedAt: new Date(),
      },
    });
    if (decided.count !== 1) throw alreadyDecided(suggestion.status);
    return toFeatureSuggestionView(await this.findOrThrow(id));
  }

  /**
   * Everyone in the Project's Organization checks a Feature about to be created against the
   * effective Guidelines: one verdict per Guideline, in their order, and a
   * question for each UNCLEAR one. Writes nothing.
   */
  async fit(user: User, projectId: string, input: FeatureFitInput): Promise<FeatureFitView> {
    await projectAccess(this.db, user, projectId);
    const guidelines = await this.foundation.referencedGuidelines(projectId);
    if (!guidelines.length) return { projectId, results: [], questions: [] };
    const project = await this.db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true },
    });
    const feature = { title: input.title, description: input.description ?? '' };
    const { model, budget } = await this.budgets.forTask('checkFeatureFit', 'featureFit');
    const projectContext = await this.retriever.forProject(
      projectId,
      `${feature.title}\n\n${feature.description}`,
      projectBudget(budget),
    );
    const checked = await this.callAi(() =>
      this.ai.checkFeatureFit(
        {
          project: { name: project.name },
          feature,
          projectContext,
          guidelines: guidelines.map(({ criterion: _, ...g }) => g),
        },
        { model },
      ),
    );
    return { projectId, ...fitOf(guidelines, checked.results) };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** The Project's most recent Decisions, newest first, as context blocks. */
  private async decisionLog(projectId: string): Promise<ContextBlock[]> {
    const decisions = await this.db.decision.findMany({
      where: { request: { feature: { team: { projectId } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: RECENT_DECISIONS,
      select: {
        id: true,
        customAnswer: true,
        rationale: true,
        choice: { select: { label: true, title: true, description: true } },
        request: {
          select: { title: true, description: true, feature: { select: { title: true } } },
        },
      },
    });
    return decisions.map((d) => ({
      source: {
        kind: 'DECISION',
        id: d.id,
        title: `Decision on ${d.request.feature.title}: ${d.request.title}`,
      },
      scope: 'PROJECT',
      text: clipForAi(decisionText(d), DECISION_CHARS),
    }));
  }

  private async findOrThrow(id: string) {
    const suggestion = await this.db.featureSuggestion.findUnique({
      where: { id },
      include: featureSuggestionInclude,
    });
    if (!suggestion) throw new NotFoundException('Feature Suggestion not found');
    return suggestion;
  }

  /** A failed or invalid AI call is a 502; the caller has written nothing yet. */
  private async callAi<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
      this.logger.error('A Feature Suggestions AI call failed', error as Error);
      throw new BadGatewayException('The AI call failed, so nothing was changed. Try again.');
    }
  }
}

/**
 * One entry per effective Guideline, in their order: the AI's first verdict on
 * it, or UNCLEAR "not assessed" when it gave none. Verdicts on handles it wasn't
 * given are dropped.
 */
export function fitOf(
  guidelines: ReferencedGuideline[],
  verdicts: {
    guideline: string;
    verdict: GuidelineFitView['verdict'];
    reason: string;
    question?: string | null;
  }[],
): Pick<FeatureFitView, 'results' | 'questions'> {
  const byRef = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) {
    const ref = v.guideline.trim().toUpperCase();
    if (!byRef.has(ref)) byRef.set(ref, v);
  }
  const results: GuidelineFitView[] = [];
  const questions: FeatureFitView['questions'] = [];
  for (const g of guidelines) {
    const v = byRef.get(g.ref);
    const verdict = v?.verdict ?? 'UNCLEAR';
    results.push({
      guidelineId: g.criterion.id,
      title: g.criterion.title,
      kind: g.criterion.kind,
      required: g.criterion.required,
      verdict,
      reason: v ? oneLine(v.reason) : 'Not assessed.',
    });
    if (verdict === 'UNCLEAR') {
      const question = v?.question?.trim() || `How does this Feature meet "${g.criterion.title}"?`;
      questions.push({ guidelineId: g.criterion.id, question });
    }
  }
  return { results, questions };
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_REASON_CHARS ? line : `${line.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function titleKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

function alreadyDecided(status?: string) {
  return new ConflictException(
    status && status !== 'PENDING'
      ? `This Feature Suggestion is already ${status.toLowerCase()}`
      : 'This Feature Suggestion was already accepted or dismissed',
  );
}
