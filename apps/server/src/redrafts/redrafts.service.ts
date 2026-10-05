import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ActionCardKind, Prisma, PrismaClient, ProposalKind, User } from '@vorasaan/db';
import {
  type ChoiceDraft,
  DEFAULT_MAX_REDRAFTS,
  diffRedrafts,
  type ProposalRedraftedEvent,
  type ProposalRedraftsView,
  type RecordedModel,
  RedraftContent,
  type RedraftDiff,
  type RedraftEvalCase,
  RedraftPointer,
  type RedraftView,
  type RequestChangesInput,
  type RequestChangesResult,
  redraftText,
  type TeamRole,
} from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import {
  AI_PORT,
  AiOutputError,
  type AiPort,
  type FeedbackForAi,
  type ReceiptLink,
} from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { ContextBudgets, projectBudget } from '../ai/context-budget.ts';
import { personLanguage, type ReplyLanguage } from '../ai/language.ts';
import { withSummaryPreferences } from '../ai/prompts.ts';
import {
  fromRecordedModelColumns,
  type RecordedModelColumns,
  toRecordedModelColumns,
} from '../ai/recorded-model.ts';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { patternsForAi, storedPatterns, withCaseTexts } from '../prompt-versions/patterns.ts';
import { PromptVersionsService, tasksOf } from '../prompt-versions/prompt-versions.service.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { ContextRetriever, splitFeatureSpec } from '../retrieval/context-retriever.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import { REDRAFT_ABANDONED_MS } from './redraft-guard.ts';

/** A proposal someone may Request changes on: its kind and id (a Decision Request's for CHOICES). */
export type ProposalRef = { kind: ProposalKind; id: string };

/** A Redraft started, finished or failed. ActionCardsService listens, to update the card. */
export type RedraftListener = (event: ProposalRedraftedEvent) => void;

/** The proposal as the person may redraft it now, and what writing its Redraft needs. */
type Target = {
  ref: ProposalRef;
  content: RedraftContent;
  /** When it was first drafted, and with which model: Redraft 1's. */
  draftedAt: Date;
  draftedWith: RecordedModelColumns;
  /** Who is told when it changes: whoever may act on it. */
  audience: string[];
  /** The state the proposal must still be in when the Redraft is written. */
  guard: Guard;
};

type Guard =
  | { kind: 'SPEC_PROPOSAL'; featureId: string; baseVersionId: string | null; specId: string }
  | { kind: 'BRIEF_PROPOSAL'; projectId: string; baseVersionId: string | null }
  | { kind: 'FEATURE_SUGGESTION'; projectId: string }
  | { kind: 'PROMPT_VERSION'; promptName: SkillName; analysisId: string }
  | {
      kind: 'CHOICES';
      featureId: string;
      status: 'DRAFT' | 'OPEN';
      deciderId: string | null;
      raiserId: string;
    };

/** Where a Redraft's Receipt says the call worked (ticket 0075): its Feature or Project. */
function receiptScope(guard: Guard): { featureId?: string; projectId?: string } {
  switch (guard.kind) {
    case 'SPEC_PROPOSAL':
    case 'CHOICES':
      return { featureId: guard.featureId };
    case 'BRIEF_PROPOSAL':
    case 'FEATURE_SUGGESTION':
      return { projectId: guard.projectId };
    case 'PROMPT_VERSION':
      return {};
  }
}

type Written = {
  content: RedraftContent;
  summary: string;
  preferences: string[];
  model: RecordedModel;
};

type RedraftRow = Prisma.RedraftGetPayload<{
  include: { requestedBy: { select: { id: true; name: true } } };
}>;

const FK: Record<
  ProposalKind,
  'requestId' | 'specProposalId' | 'briefProposalId' | 'featureSuggestionId' | 'promptVersionId'
> = {
  CHOICES: 'requestId',
  SPEC_PROPOSAL: 'specProposalId',
  BRIEF_PROPOSAL: 'briefProposalId',
  FEATURE_SUGGESTION: 'featureSuggestionId',
  PROMPT_VERSION: 'promptVersionId',
};

/**
 * The Action Card kind whose target is this proposal (a Decision Request for its Choices).
 * A Prompt Version (ticket 0072) is proposed from Settings, never in a Conversation.
 */
export const CARD_KIND: Partial<Record<ProposalKind, ActionCardKind>> = {
  CHOICES: 'DECISION_REQUEST',
  SPEC_PROPOSAL: 'SPEC_PROPOSAL',
  BRIEF_PROPOSAL: 'BRIEF_PROPOSAL',
  FEATURE_SUGGESTION: 'FEATURE_SUGGESTION',
};

const NAME: Record<ProposalKind, string> = {
  CHOICES: 'The Choices',
  SPEC_PROPOSAL: 'This Spec Proposal',
  BRIEF_PROPOSAL: 'This Brief Proposal',
  FEATURE_SUGGESTION: 'This Feature Suggestion',
  PROMPT_VERSION: 'This Prompt Version',
};

/** The limit of Request changes per proposal: VORASAAN_MAX_REDRAFTS, else 10. */
export function maxRedrafts(env: Record<string, string | undefined> = process.env): number {
  const raw = env.VORASAAN_MAX_REDRAFTS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_REDRAFTS;
}

/**
 * Request changes and Redrafts (ADR 0013, ticket 0065). The people who may approve or
 * decline a proposal say what to change, optionally pointing at a Choice or at a section
 * or lines of a Markdown proposal; the AI writes the next Redraft of the same proposal.
 *
 * The proposal itself (a Spec or Brief Proposal's Markdown, a Feature Suggestion's fields,
 * a Decision Request's Choices) always holds its latest READY Redraft, so Approve, which
 * goes through each proposal's own service, applies only that one. Every Redraft is kept
 * here with the feedback that caused it, who gave it, and the model that wrote it;
 * Redraft 1 (the proposal as first drafted) is kept when the first Request changes is made.
 *
 * A proposal approved, declined or stale can't be redrafted (409); neither can one past
 * the limit. While a Redraft is being written (WRITING), Approve and another Request
 * changes get a 409; a database index keeps one WRITING Redraft per proposal. The AI call
 * runs outside any transaction, then the Redraft and the proposal are written together,
 * only if the proposal is still as it was. Nothing changes before Approve.
 */
@Injectable()
export class RedraftsService {
  private readonly logger = new Logger(RedraftsService.name);
  private readonly listeners = new Set<RedraftListener>();
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    @InjectClock() private readonly clock: Clock,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly budgets: ContextBudgets,
    private readonly models: AiSettingsService,
    private readonly notifications: NotificationsService,
    private readonly bus: EventBus,
    private readonly receipts: ReceiptsService,
    private readonly prompts: PromptVersionsService,
  ) {}

  /** Called on every Redraft event, after it is committed. Returns the unsubscribe. */
  listen(listener: RedraftListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for Redrafts being written (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  // ─── Request changes ──────────────────────────────────────────────────────

  /** Writes the next Redraft from the feedback and answers once it is READY. */
  async requestChanges(
    user: User,
    ref: ProposalRef,
    input: RequestChangesInput,
  ): Promise<RequestChangesResult> {
    const { done } = await this.start(user, ref, input);
    return done;
  }

  /**
   * Checks who asks and the proposal's state, and claims the next Redraft number (WRITING);
   * every refusal is thrown here, having stored nothing. The AI then writes it: `done`
   * settles once it is READY, or rejects having changed nothing (502, or 409 when the
   * proposal moved on meanwhile). A chat app's press uses `number` to answer at once.
   */
  async start(
    user: User,
    ref: ProposalRef,
    input: RequestChangesInput,
  ): Promise<{ number: number; done: Promise<RequestChangesResult> }> {
    const target = await this.authorize(user, ref);
    const pointer = input.pointer ?? null;
    const pointed = pointerText(target.content, pointer);
    const limit = maxRedrafts();
    await this.clearAbandoned(ref);
    const latest = await this.db.redraft.findFirst({
      where: { proposalKind: ref.kind, proposalId: ref.id },
      orderBy: { number: 'desc' },
      select: { number: true, status: true },
    });
    if (latest?.status === 'WRITING') throw writingConflict(latest.number);
    const used = Math.max(0, (latest?.number ?? 1) - 1);
    if (used >= limit) {
      throw new ConflictException(
        `${NAME[ref.kind]} was redrafted ${limit} time${limit === 1 ? '' : 's'}, the most allowed. Approve it, decline it, or edit it by hand.`,
      );
    }

    const number = (latest?.number ?? 1) + 1;
    let writingId: string;
    try {
      writingId = await this.db.$transaction(async (tx) => {
        const fk = { [FK[ref.kind]]: ref.id };
        if (!latest) {
          // Redraft 1: the proposal as first drafted, kept before anything changes it.
          await tx.redraft.create({
            data: {
              proposalKind: ref.kind,
              proposalId: ref.id,
              number: 1,
              status: 'READY',
              content: target.content,
              preferences: [],
              ...target.draftedWith,
              createdAt: target.draftedAt,
              readyAt: target.draftedAt,
              ...fk,
            },
          });
        }
        const row = await tx.redraft.create({
          data: {
            proposalKind: ref.kind,
            proposalId: ref.id,
            number,
            status: 'WRITING',
            feedback: input.feedback,
            pointer: pointer ?? undefined,
            requestedById: user.id,
            preferences: [],
            createdAt: this.clock.now(),
            ...fk,
          },
          select: { id: true },
        });
        return row.id;
      });
    } catch (error) {
      // Someone else's Request changes got there first.
      if ((error as { code?: string })?.code === 'P2002') throw writingConflict(number);
      throw error;
    }
    this.announce(target, user.id, {
      kind: ref.kind,
      proposalId: ref.id,
      number,
      status: 'WRITING',
    });
    // The feedback on the Redraft before it, linked to the proposal's Receipt (ticket 0070).
    this.receipts.outcome({
      kind: 'REQUEST_CHANGES',
      proposal: ref,
      actorId: user.id,
      redraft: number - 1,
      reason: input.feedback,
    });

    const done = this.write(user, target, { id: writingId, number }, input, pointed);
    this.running.add(done);
    done.then(
      () => this.running.delete(done),
      () => this.running.delete(done),
    );
    return { number, done };
  }

  /** Runs the AI, then stores the Redraft and the proposal together; undoes the claim on failure. */
  private async write(
    user: User,
    target: Target,
    writing: { id: string; number: number },
    input: RequestChangesInput,
    pointed: string | null,
  ): Promise<RequestChangesResult> {
    const { ref } = target;
    const event = { kind: ref.kind, proposalId: ref.id, number: writing.number };
    try {
      const earlier = await this.db.redraft.findMany({
        where: {
          proposalKind: ref.kind,
          proposalId: ref.id,
          status: 'READY',
          number: { gt: 1 },
        },
        orderBy: { number: 'asc' },
        select: { number: true, feedback: true, pointer: true, content: true },
      });
      const feedback = {
        current: writing.number - 1,
        feedback: { redraft: writing.number - 1, feedback: input.feedback, pointer: pointed },
        earlier: earlier.map(
          (r): FeedbackForAi => ({
            // The Redraft the feedback was given on.
            redraft: r.number - 1,
            feedback: r.feedback ?? '',
            pointer: describePointer(r.pointer),
          }),
        ),
      };
      const language = await personLanguage(this.db, user.id);
      const written = await this.callAi(target, feedback, input.feedback, language, {
        requestedById: user.id,
        output: { kind: 'REDRAFT', id: writing.id },
        proposal: { kind: ref.kind, id: ref.id, redraft: writing.number },
        ...receiptScope(target.guard),
      });
      await this.store(target, writing, written);
      await this.rememberPreferences(ref, written.preferences);
      this.announce(target, user.id, { ...event, status: 'READY' });
      return await this.result(user, ref, writing.number);
    } catch (error) {
      await this.db.redraft
        .deleteMany({ where: { id: writing.id, status: 'WRITING' } })
        .catch(() => undefined);
      this.announce(target, user.id, { ...event, status: 'FAILED' });
      if (error instanceof HttpException) throw error;
      if (error instanceof AiOutputError) throw new BadGatewayException(error.message);
      this.logger.error('A Redraft failed', error as Error);
      throw new BadGatewayException(
        'The AI could not write the Redraft, so nothing changed. Try again.',
      );
    }
  }

  /** The Redraft and the proposal's new content, together, only if the proposal is still as it was. */
  private async store(target: Target, writing: { id: string }, written: Written) {
    const { ref, guard } = target;
    const model = toRecordedModelColumns(written.model);
    await this.db.$transaction(async (tx) => {
      const moved = () =>
        new ConflictException(
          `${NAME[ref.kind]} changed while the Redraft was being written, so the Redraft was dropped.`,
        );
      switch (guard.kind) {
        case 'SPEC_PROPOSAL': {
          if (written.content.kind !== 'MARKDOWN') throw moved();
          const latest = await tx.specVersion.findFirst({
            where: { featureId: guard.featureId },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if ((latest?.id ?? null) !== guard.baseVersionId) throw moved();
          const updated = await tx.specProposal.updateMany({
            where: { id: ref.id, status: 'PENDING' },
            data: { proposedMarkdown: written.content.markdown, ...model },
          });
          if (updated.count !== 1) throw moved();
          break;
        }
        case 'BRIEF_PROPOSAL': {
          if (written.content.kind !== 'MARKDOWN') throw moved();
          const latest = await tx.briefVersion.findFirst({
            where: { projectId: guard.projectId },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if ((latest?.id ?? null) !== guard.baseVersionId) throw moved();
          const updated = await tx.briefProposal.updateMany({
            where: { id: ref.id, status: 'PENDING' },
            data: { proposedMarkdown: written.content.markdown, ...model },
          });
          if (updated.count !== 1) throw moved();
          break;
        }
        case 'FEATURE_SUGGESTION': {
          if (written.content.kind !== 'FEATURE_SUGGESTION') throw moved();
          const { kind: _, ...fields } = written.content;
          const updated = await tx.featureSuggestion.updateMany({
            where: { id: ref.id, status: 'PENDING' },
            data: fields,
          });
          if (updated.count !== 1) throw moved();
          break;
        }
        case 'PROMPT_VERSION': {
          if (written.content.kind !== 'PROMPT') throw moved();
          const updated = await tx.promptVersion.updateMany({
            where: { id: ref.id, status: 'PROPOSED' },
            data: {
              template: written.content.template,
              rationale: written.content.rationale ?? null,
            },
          });
          if (updated.count !== 1) throw moved();
          break;
        }
        case 'CHOICES': {
          if (written.content.kind !== 'CHOICES') throw moved();
          const updated = await tx.decisionRequest.updateMany({
            where: { id: ref.id, status: guard.status, deciderId: guard.deciderId },
            data: {
              choicesApprovedModelId: model.approvedModelId,
              choicesModelDisplayName: model.modelDisplayName,
              choicesModelName: model.modelName,
            },
          });
          if (updated.count !== 1) throw moved();
          await tx.choice.deleteMany({ where: { requestId: ref.id } });
          await tx.choice.createMany({
            data: written.content.choices.map((c, position) => ({
              ...c,
              position,
              requestId: ref.id,
            })),
          });
          break;
        }
      }
      const ready = await tx.redraft.updateMany({
        where: { id: writing.id, status: 'WRITING' },
        data: {
          status: 'READY',
          content: written.content,
          summary: written.summary,
          preferences: written.preferences,
          readyAt: this.clock.now(),
          ...model,
        },
      });
      if (ready.count !== 1) throw moved();
    });
  }

  /** The AI's Redraft of this kind of proposal, from the proposal and the usual context. */
  private async callAi(
    target: Target,
    feedback: { current: number; feedback: FeedbackForAi; earlier: FeedbackForAi[] },
    query: string,
    language: ReplyLanguage,
    receipt: ReceiptLink,
  ): Promise<Written> {
    const { guard, content } = target;
    switch (guard.kind) {
      case 'SPEC_PROPOSAL': {
        if (content.kind !== 'MARKDOWN') throw new Error('Not a Markdown proposal');
        const [feature, base] = await Promise.all([
          this.db.feature.findUniqueOrThrow({
            where: { id: guard.featureId },
            select: { title: true, description: true },
          }),
          guard.baseVersionId
            ? this.db.specVersion.findUnique({
                where: { id: guard.baseVersionId },
                select: { markdown: true },
              })
            : null,
        ]);
        const specMarkdown = base?.markdown ?? '';
        const { model, budget } = await this.budgets.forTask(
          'redraftSpecProposal',
          'decisionRequest',
          { fixed: estimateTokens(specMarkdown) + estimateTokens(content.markdown) },
        );
        const { foundation, contextBudget } = await this.foundation.forFeature(
          guard.featureId,
          budget,
        );
        const { context } = splitFeatureSpec(
          await this.retriever.forFeature(
            guard.featureId,
            `${feature.title}\n\n${query}`,
            contextBudget,
          ),
        );
        const out = await this.ai.redraftSpecProposal(
          {
            ...feedback,
            feature: { title: feature.title, description: feature.description ?? '' },
            specMarkdown,
            proposedMarkdown: content.markdown,
            context: withoutBrief(context),
            foundation,
          },
          { model, language, receipt },
        );
        return {
          content: { kind: 'MARKDOWN', markdown: normalizeMarkdown(out.proposedMarkdown) },
          summary: out.summary,
          preferences: out.preferences,
          model: await this.models.record(model),
        };
      }
      case 'BRIEF_PROPOSAL': {
        if (content.kind !== 'MARKDOWN') throw new Error('Not a Markdown proposal');
        const [project, base, guidelines] = await Promise.all([
          this.db.project.findUniqueOrThrow({
            where: { id: guard.projectId },
            select: { name: true },
          }),
          guard.baseVersionId
            ? this.db.briefVersion.findUnique({
                where: { id: guard.baseVersionId },
                select: { markdown: true },
              })
            : null,
          this.foundation.referencedGuidelines(guard.projectId),
        ]);
        const briefMarkdown = base?.markdown ?? '';
        const { model, budget } = await this.budgets.forTask('redraftBriefProposal', 'grilling', {
          fixed: estimateTokens(briefMarkdown) + estimateTokens(content.markdown),
        });
        const projectContext = (
          await this.retriever.forProject(
            guard.projectId,
            `${project.name}\n\n${query}`,
            projectBudget(budget),
          )
        ).filter((b) => b.source.kind !== 'BRIEF_VERSION');
        const out = await this.ai.redraftBriefProposal(
          {
            ...feedback,
            project: { name: project.name },
            briefMarkdown,
            proposedMarkdown: content.markdown,
            projectContext,
            guidelines: guidelines.map(({ ref: _, criterion: __, ...g }) => g),
          },
          { model, language, receipt },
        );
        return {
          content: {
            kind: 'MARKDOWN',
            markdown: normalizeMarkdown(out.proposedMarkdown),
            summary: content.summary ?? null,
          },
          summary: out.summary,
          preferences: out.preferences,
          model: await this.models.record(model),
        };
      }
      case 'FEATURE_SUGGESTION': {
        if (content.kind !== 'FEATURE_SUGGESTION') throw new Error('Not a Feature Suggestion');
        const [project, guidelines] = await Promise.all([
          this.db.project.findUniqueOrThrow({
            where: { id: guard.projectId },
            select: { name: true },
          }),
          this.foundation.referencedGuidelines(guard.projectId),
        ]);
        const { model, budget } = await this.budgets.forTask(
          'redraftFeatureSuggestion',
          'featureSuggestions',
        );
        const projectContext = await this.retriever.forProject(
          guard.projectId,
          `${content.title}\n\n${content.rationale}\n\n${query}`,
          projectBudget(budget),
        );
        const { kind: _, ...suggestion } = content;
        const out = await this.ai.redraftFeatureSuggestion(
          {
            ...feedback,
            project: { name: project.name },
            suggestion,
            projectContext,
            guidelines: guidelines.map(({ ref: _r, criterion: __, ...g }) => g),
          },
          { model, language, receipt },
        );
        return {
          content: {
            kind: 'FEATURE_SUGGESTION',
            title: out.title,
            rationale: out.rationale,
            businessValue: out.businessValue,
            effort: out.effort,
            risk: out.risk,
          },
          summary: out.summary,
          preferences: out.preferences,
          model: await this.models.record(model),
        };
      }
      case 'PROMPT_VERSION': {
        if (content.kind !== 'PROMPT') throw new Error('Not a Prompt Version');
        const name = guard.promptName;
        const [analysis, active, placeholders, model] = await Promise.all([
          this.db.promptAnalysis.findUnique({
            where: { id: guard.analysisId },
            select: { patterns: true },
          }),
          this.prompts.active(name),
          this.prompts.requiredPlaceholders(name),
          this.models.chooseModel('redraftPromptVersion'),
        ]);
        const out = await this.ai.redraftPromptVersion(
          {
            ...feedback,
            prompt: { name, tasks: tasksOf(name) },
            template: content.template,
            rationale: content.rationale ?? '',
            active: await this.prompts.template(name, active.number),
            placeholders,
            patterns: patternsForAi(
              await withCaseTexts(this.db, storedPatterns(analysis?.patterns)),
            ),
          },
          { model, language, receipt },
        );
        const template = `${out.template.trim()}\n`;
        try {
          await this.prompts.assertRenders(name, template);
        } catch (error) {
          throw new BadGatewayException(
            `The AI's Redraft can't be used as this prompt (${(error as Error).message}), so nothing changed. Try again.`,
          );
        }
        return {
          content: { kind: 'PROMPT', template, rationale: out.rationale },
          summary: out.summary,
          preferences: out.preferences,
          model: await this.models.record(model),
        };
      }
      case 'CHOICES': {
        if (content.kind !== 'CHOICES') throw new Error('Not Choices');
        const request = await this.db.decisionRequest.findUniqueOrThrow({
          where: { id: target.ref.id },
          select: { kind: true, title: true, description: true },
        });
        const raiserRole = await this.db.roleOwner.findFirst({
          where: { featureId: guard.featureId, userId: guard.raiserId },
          orderBy: { role: 'asc' },
          select: { role: true },
        });
        const { model, budget } = await this.budgets.forTask('redraftChoices', 'decisionRequest');
        const { foundation, contextBudget } = await this.foundation.forFeature(
          guard.featureId,
          budget,
        );
        const { spec, context } = splitFeatureSpec(
          await this.retriever.forFeature(
            guard.featureId,
            `${request.title}\n\n${request.description}\n\n${query}`,
            contextBudget,
            { excludeRequestId: target.ref.id },
          ),
        );
        const out = await this.ai.redraftChoices(
          {
            ...feedback,
            specMarkdown: spec?.text ?? '(This Feature has no Spec yet.)',
            request: {
              kind: request.kind,
              title: request.title,
              description: request.description,
              raiserRole: (raiserRole?.role ?? 'PO') as TeamRole,
            },
            choices: content.choices,
            context: withoutBrief(context),
            foundation,
          },
          { model, language, receipt },
        );
        return {
          content: {
            kind: 'CHOICES',
            // Labelled in order, whatever the AI wrote: the buttons say "Choose A".
            choices: out.choices.map((c, i) => ({ ...c, label: String.fromCharCode(65 + i) })),
          },
          summary: out.summary,
          preferences: out.preferences,
          model: await this.models.record(model),
        };
      }
    }
  }

  // ─── Who may, and when ────────────────────────────────────────────────────

  /**
   * The proposal, if `user` may Request changes on it now: 404 for an unknown one, 403
   * for anyone who may not approve or decline it, 409 once it is approved, declined or
   * stale, 422 for Choices a plain-text Question doesn't have.
   */
  private async authorize(user: User, ref: ProposalRef): Promise<Target> {
    switch (ref.kind) {
      case 'SPEC_PROPOSAL': {
        const p = await this.db.specProposal.findUnique({ where: { id: ref.id } });
        if (!p) throw new NotFoundException('Spec Proposal not found');
        if (p.approverId !== user.id) {
          throw new ForbiddenException(
            'Only the approver can request changes to this Spec Proposal',
          );
        }
        if (p.status !== 'PENDING') {
          throw new ConflictException(`This Spec Proposal is already ${p.status.toLowerCase()}`);
        }
        const latest = await this.db.specVersion.findFirst({
          where: { featureId: p.featureId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if ((latest?.id ?? null) !== p.baseVersionId) {
          throw new ConflictException(
            'The Spec has changed since this proposal was drafted, so it can no longer be redrafted',
          );
        }
        return {
          ref,
          content: { kind: 'MARKDOWN', markdown: p.proposedMarkdown },
          draftedAt: p.createdAt,
          draftedWith: pickModel(p),
          audience: [p.approverId],
          guard: {
            kind: 'SPEC_PROPOSAL',
            featureId: p.featureId,
            baseVersionId: p.baseVersionId,
            specId: p.id,
          },
        };
      }
      case 'BRIEF_PROPOSAL': {
        const p = await this.db.briefProposal.findUnique({ where: { id: ref.id } });
        if (!p) throw new NotFoundException('Brief Proposal not found');
        await projectAccess(this.db, user, p.projectId);
        if (p.approverId !== user.id) {
          throw new ForbiddenException(
            'Only the approver can request changes to this Brief Proposal',
          );
        }
        if (p.status !== 'PENDING') {
          throw new ConflictException(`This Brief Proposal is already ${p.status.toLowerCase()}`);
        }
        const latest = await this.db.briefVersion.findFirst({
          where: { projectId: p.projectId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if ((latest?.id ?? null) !== p.baseVersionId) {
          throw new ConflictException(
            'The Project Brief has changed since this proposal was drafted, so it can no longer be redrafted',
          );
        }
        return {
          ref,
          content: { kind: 'MARKDOWN', markdown: p.proposedMarkdown, summary: p.summary },
          draftedAt: p.createdAt,
          draftedWith: pickModel(p),
          audience: [p.approverId],
          guard: { kind: 'BRIEF_PROPOSAL', projectId: p.projectId, baseVersionId: p.baseVersionId },
        };
      }
      case 'FEATURE_SUGGESTION': {
        const s = await this.db.featureSuggestion.findUnique({ where: { id: ref.id } });
        if (!s) throw new NotFoundException('Feature Suggestion not found');
        // Whoever may accept or dismiss it: the Project's POs and Admins.
        await assertCanEditProject(this.db, user, s.projectId);
        if (s.status !== 'PENDING') {
          throw new ConflictException(
            `This Feature Suggestion is already ${s.status.toLowerCase()}`,
          );
        }
        return {
          ref,
          content: {
            kind: 'FEATURE_SUGGESTION',
            title: s.title,
            rationale: s.rationale,
            businessValue: s.businessValue,
            effort: s.effort,
            risk: s.risk,
          },
          draftedAt: s.createdAt,
          draftedWith: { approvedModelId: null, modelDisplayName: null, modelName: null },
          audience: [user.id],
          guard: { kind: 'FEATURE_SUGGESTION', projectId: s.projectId },
        };
      }
      case 'PROMPT_VERSION': {
        const v = await this.db.promptVersion.findUnique({ where: { id: ref.id } });
        if (!v) throw new NotFoundException('Prompt Version not found');
        await this.assertAdmin(
          user,
          'Only an Organization Admin can request changes to a Prompt Version',
        );
        if (!v.analysisId) {
          throw new UnprocessableEntityException(
            'Only a Prompt Version the AI proposed can be redrafted. Write a new version instead.',
          );
        }
        if (v.status !== 'PROPOSED') {
          throw new ConflictException(`This Prompt Version is already ${v.status.toLowerCase()}`);
        }
        return {
          ref,
          content: { kind: 'PROMPT', template: v.template, rationale: v.rationale },
          draftedAt: v.createdAt,
          draftedWith: { approvedModelId: null, modelDisplayName: null, modelName: null },
          audience: [user.id],
          guard: {
            kind: 'PROMPT_VERSION',
            promptName: this.prompts.prompt(v.promptName),
            analysisId: v.analysisId,
          },
        };
      }
      case 'CHOICES': {
        const r = await this.db.decisionRequest.findUnique({
          where: { id: ref.id },
          include: {
            choices: { orderBy: { position: 'asc' } },
            recipients: { select: { userId: true } },
          },
        });
        if (!r) throw new NotFoundException('Decision Request not found');
        const recipient = r.recipients.some((x) => x.userId === user.id);
        // The Raiser reviews them before sending; once sent, whoever decides picks one.
        const mayAct =
          r.status === 'DRAFT'
            ? r.raiserId === user.id
            : r.deciderId === user.id || (r.deciderId === null && recipient);
        const involved = r.raiserId === user.id || r.deciderId === user.id || recipient;
        if (r.status !== 'DRAFT' && r.status !== 'OPEN') {
          if (!involved) {
            throw new ForbiddenException(
              'Only the Raiser (before sending) or whoever decides can request changes to the Choices',
            );
          }
          throw new ConflictException(
            `This Decision Request is ${r.status.toLowerCase().replace('_', ' ')}, so its Choices can no longer be redrafted`,
          );
        }
        if (!mayAct) {
          throw new ForbiddenException(
            r.status === 'DRAFT'
              ? 'Only the Raiser can request changes to the Choices before sending'
              : 'Only whoever decides this Decision Request can request changes to its Choices',
          );
        }
        if (!r.withChoices || r.choices.length === 0) {
          throw new UnprocessableEntityException('This Question was raised without Choices');
        }
        return {
          ref,
          content: {
            kind: 'CHOICES',
            choices: r.choices.map((c) => ({
              label: c.label,
              title: c.title,
              description: c.description,
              impactScope: c.impactScope,
              impactTime: c.impactTime,
              impactRisk: c.impactRisk,
            })),
          },
          draftedAt: r.createdAt,
          draftedWith: {
            approvedModelId: r.choicesApprovedModelId,
            modelDisplayName: r.choicesModelDisplayName,
            modelName: r.choicesModelName,
          },
          audience:
            r.status === 'DRAFT'
              ? [r.raiserId]
              : r.deciderId
                ? [r.deciderId]
                : r.recipients.map((x) => x.userId),
          guard: {
            kind: 'CHOICES',
            featureId: r.featureId,
            status: r.status,
            deciderId: r.deciderId,
            raiserId: r.raiserId,
          },
        };
      }
    }
  }

  /** Who may see the proposal's Redrafts: whoever may see the proposal. 404 for an unknown one. */
  private async assertVisible(user: User, ref: ProposalRef) {
    switch (ref.kind) {
      case 'SPEC_PROPOSAL': {
        const exists = await this.db.specProposal.count({ where: { id: ref.id } });
        if (!exists) throw new NotFoundException('Spec Proposal not found');
        return;
      }
      case 'BRIEF_PROPOSAL': {
        const p = await this.db.briefProposal.findUnique({
          where: { id: ref.id },
          select: { projectId: true },
        });
        if (!p) throw new NotFoundException('Brief Proposal not found');
        await projectAccess(this.db, user, p.projectId);
        return;
      }
      case 'FEATURE_SUGGESTION': {
        const s = await this.db.featureSuggestion.findUnique({
          where: { id: ref.id },
          select: { projectId: true },
        });
        if (!s) throw new NotFoundException('Feature Suggestion not found');
        await projectAccess(this.db, user, s.projectId);
        return;
      }
      case 'CHOICES': {
        const exists = await this.db.decisionRequest.count({ where: { id: ref.id } });
        if (!exists) throw new NotFoundException('Decision Request not found');
        return;
      }
      case 'PROMPT_VERSION': {
        const exists = await this.db.promptVersion.count({ where: { id: ref.id } });
        if (!exists) throw new NotFoundException('Prompt Version not found');
        await this.assertAdmin(
          user,
          'Only an Organization Admin can see the Redrafts of a Prompt Version',
        );
        return;
      }
    }
  }

  private async assertAdmin(user: User, message: string) {
    const admin = await this.db.orgMembership.count({ where: { userId: user.id, role: 'ADMIN' } });
    if (!admin) throw new ForbiddenException(message);
  }

  /** A WRITING Redraft left by a server that stopped mid-call no longer holds the proposal. */
  private async clearAbandoned(ref: ProposalRef) {
    await this.db.redraft.deleteMany({
      where: {
        proposalKind: ref.kind,
        proposalId: ref.id,
        status: 'WRITING',
        createdAt: { lte: new Date(this.clock.now().getTime() - REDRAFT_ABANDONED_MS) },
      },
    });
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /**
   * Every Redraft of the proposal, oldest first. One never redrafted has only Redraft 1,
   * read from the proposal itself.
   */
  async list(user: User, ref: ProposalRef): Promise<ProposalRedraftsView> {
    await this.assertVisible(user, ref);
    const rows = await this.rows(ref);
    const limit = maxRedrafts();
    const now = this.clock.now();
    const live = rows.filter(
      (r) => r.status === 'READY' || r.createdAt.getTime() > now.getTime() - REDRAFT_ABANDONED_MS,
    );
    let redrafts = live.map(toRedraftView);
    let canRequestChanges = true;
    let reason: string | null = null;
    try {
      const target = await this.authorize(user, ref);
      if (!redrafts.length) redrafts = [firstView(target)];
    } catch (error) {
      canRequestChanges = false;
      reason = error instanceof HttpException ? error.message : 'Not available';
      if (!redrafts.length) {
        const first = await this.currentContent(ref);
        if (first) redrafts = [first];
      }
    }
    const ready = redrafts.filter((r) => r.status === 'READY');
    const current = ready.at(-1)?.number ?? 1;
    const writing = redrafts.some((r) => r.status === 'WRITING');
    const latestNumber = redrafts.at(-1)?.number ?? 1;
    const left = Math.max(0, limit - (latestNumber - 1));
    if (canRequestChanges && writing) {
      canRequestChanges = false;
      reason = 'A Redraft is being written';
    } else if (canRequestChanges && left === 0) {
      canRequestChanges = false;
      reason = `It was redrafted ${limit} times, the most allowed`;
    }
    return {
      kind: ref.kind,
      proposalId: ref.id,
      current,
      writing,
      limit,
      left,
      canRequestChanges,
      reason,
      redrafts,
    };
  }

  /** The diff between two Redrafts of the proposal, like Spec Versions' (0020). */
  async diff(user: User, ref: ProposalRef, from: number, to: number): Promise<RedraftDiff> {
    const { redrafts } = await this.list(user, ref);
    const a = redrafts.find((r) => r.number === from && r.status === 'READY');
    const b = redrafts.find((r) => r.number === to && r.status === 'READY');
    if (!a || !b) throw new NotFoundException(`Redraft ${a ? to : from} not found`);
    return diffRedrafts(a, b);
  }

  /**
   * A short summary of the proposal's Redrafts for its Action Card: the current one, one
   * being written, how many are left, and the feedback behind the current one.
   */
  async summary(ref: ProposalRef): Promise<{
    current: number;
    writing: boolean;
    left: number;
    feedback: string | null;
  }> {
    const now = this.clock.now();
    const rows = await this.db.redraft.findMany({
      where: { proposalKind: ref.kind, proposalId: ref.id },
      orderBy: { number: 'asc' },
      select: { number: true, status: true, feedback: true, createdAt: true },
    });
    const ready = rows.filter((r) => r.status === 'READY');
    const writing = rows.some(
      (r) => r.status === 'WRITING' && r.createdAt.getTime() > now.getTime() - REDRAFT_ABANDONED_MS,
    );
    const latest = rows.at(-1)?.number ?? 1;
    return {
      current: ready.at(-1)?.number ?? 1,
      writing,
      left: Math.max(0, maxRedrafts() - (latest - 1)),
      feedback: ready.at(-1)?.feedback ?? null,
    };
  }

  /** Every Request changes, as eval cases for the redraft prompts (Admins only). */
  async evalCases(kind?: ProposalKind): Promise<RedraftEvalCase[]> {
    const rows = await this.db.redraft.findMany({
      where: { status: 'READY', ...(kind ? { proposalKind: kind } : {}) },
      orderBy: [{ proposalKind: 'asc' }, { proposalId: 'asc' }, { number: 'asc' }],
    });
    const cases: RedraftEvalCase[] = [];
    const byProposal = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.proposalKind}:${row.proposalId}`;
      byProposal.set(key, [...(byProposal.get(key) ?? []), row]);
    }
    for (const list of byProposal.values()) {
      for (const row of list) {
        if (row.number < 2 || !row.feedback) continue;
        const before = list.find((r) => r.number === row.number - 1);
        const beforeContent = before && RedraftContent.safeParse(before.content);
        const afterContent = RedraftContent.safeParse(row.content);
        if (!beforeContent?.success || !afterContent.success) continue;
        cases.push({
          kind: row.proposalKind,
          proposalId: row.proposalId,
          number: row.number,
          feedback: row.feedback,
          pointer: parsePointer(row.pointer),
          earlierFeedback: list
            .filter((r) => r.number > 1 && r.number < row.number && r.feedback)
            .map((r) => r.feedback as string),
          before: redraftText(beforeContent.data),
          after: redraftText(afterContent.data),
          preferences: row.preferences,
          draftedWith: fromRecordedModelColumns(row),
          createdAt: row.createdAt.toISOString(),
        });
      }
    }
    return cases;
  }

  private rows(ref: ProposalRef): Promise<RedraftRow[]> {
    return this.db.redraft.findMany({
      where: { proposalKind: ref.kind, proposalId: ref.id },
      orderBy: { number: 'asc' },
      include: { requestedBy: { select: { id: true, name: true } } },
    });
  }

  /** Redraft 1 of a proposal never redrafted and no longer open: what it holds. */
  private async currentContent(ref: ProposalRef): Promise<RedraftView | null> {
    switch (ref.kind) {
      case 'SPEC_PROPOSAL': {
        const p = await this.db.specProposal.findUnique({ where: { id: ref.id } });
        return p
          ? viewOf({ kind: 'MARKDOWN', markdown: p.proposedMarkdown }, p.createdAt, pickModel(p))
          : null;
      }
      case 'BRIEF_PROPOSAL': {
        const p = await this.db.briefProposal.findUnique({ where: { id: ref.id } });
        return p
          ? viewOf(
              { kind: 'MARKDOWN', markdown: p.proposedMarkdown, summary: p.summary },
              p.createdAt,
              pickModel(p),
            )
          : null;
      }
      case 'FEATURE_SUGGESTION': {
        const s = await this.db.featureSuggestion.findUnique({ where: { id: ref.id } });
        return s
          ? viewOf(
              {
                kind: 'FEATURE_SUGGESTION',
                title: s.title,
                rationale: s.rationale,
                businessValue: s.businessValue,
                effort: s.effort,
                risk: s.risk,
              },
              s.createdAt,
              null,
            )
          : null;
      }
      case 'PROMPT_VERSION': {
        const v = await this.db.promptVersion.findUnique({ where: { id: ref.id } });
        return v
          ? viewOf(
              { kind: 'PROMPT', template: v.template, rationale: v.rationale },
              v.createdAt,
              null,
            )
          : null;
      }
      case 'CHOICES': {
        const r = await this.db.decisionRequest.findUnique({
          where: { id: ref.id },
          include: { choices: { orderBy: { position: 'asc' } } },
        });
        return r
          ? viewOf({ kind: 'CHOICES', choices: r.choices.map(choiceDraftOf) }, r.createdAt, {
              approvedModelId: r.choicesApprovedModelId,
              modelDisplayName: r.choicesModelDisplayName,
              modelName: r.choicesModelName,
            })
          : null;
      }
    }
  }

  private async result(
    user: User,
    ref: ProposalRef,
    number: number,
  ): Promise<RequestChangesResult> {
    const redrafts = await this.list(user, ref);
    const redraft = redrafts.redrafts.find((r) => r.number === number);
    const before = redrafts.redrafts.find((r) => r.number === number - 1);
    if (!redraft || !before) throw new NotFoundException(`Redraft ${number} not found`);
    return { redraft, redrafts, diff: diffRedrafts(before, redraft) };
  }

  // ─── After a Redraft ──────────────────────────────────────────────────────

  /**
   * A preference stated in the feedback (language, length, style) goes into the
   * Conversation Summary of the Conversation the proposal came from (ADR 0012), so later
   * proposals there follow it. Retried when a fold writes the summary at the same moment.
   */
  private async rememberPreferences(ref: ProposalRef, preferences: string[]) {
    const cardKind = CARD_KIND[ref.kind];
    if (!preferences.length || !cardKind) return;
    const card = await this.db.actionCard.findUnique({
      where: { kind_targetId: { kind: cardKind, targetId: ref.id } },
      select: { conversationId: true },
    });
    if (!card) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const conversation = await this.db.conversation.findUnique({
        where: { id: card.conversationId },
        select: { summary: true },
      });
      if (!conversation) return;
      const summary = withSummaryPreferences(conversation.summary, preferences);
      if (summary === conversation.summary) return;
      const saved = await this.db.conversation.updateMany({
        where: { id: card.conversationId, summary: conversation.summary },
        data: { summary },
      });
      if (saved.count === 1) return;
    }
    this.logger.warn('Could not add the preferences to a Conversation Summary');
  }

  /** Tells whoever may act on the proposal (and its Action Card's owner, via the listeners). */
  private announce(target: Target, actorId: string, event: ProposalRedraftedEvent) {
    const to = new Set([...target.audience, actorId]);
    for (const userId of to) this.bus.emit(userId, { event: 'proposal.redrafted', data: event });
    if (event.status === 'READY') {
      const outbox = this.notifications.outbox().inboxChanged([...to]);
      // Sent cards in people's chat apps show the new Choices (Slack and Teams edit them).
      if (target.ref.kind === 'CHOICES' && target.guard.kind === 'CHOICES') {
        outbox.chatCard({ kind: 'REDRAFTED', requestId: target.ref.id, to: target.audience });
      }
      void this.notifications.publish(outbox);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`A Redraft listener failed: ${(error as Error)?.message}`);
      }
    }
  }
}

function writingConflict(number: number) {
  return new ConflictException(
    `Redraft ${number} of this proposal is being written. Wait for it, then try again.`,
  );
}

function pickModel(row: RecordedModelColumns): RecordedModelColumns {
  return {
    approvedModelId: row.approvedModelId,
    modelDisplayName: row.modelDisplayName,
    modelName: row.modelName,
  };
}

function choiceDraftOf(c: ChoiceDraft): ChoiceDraft {
  return {
    label: c.label,
    title: c.title,
    description: c.description,
    impactScope: c.impactScope,
    impactTime: c.impactTime,
    impactRisk: c.impactRisk,
  };
}

function parsePointer(value: unknown): RedraftPointer | null {
  const parsed = RedraftPointer.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A stored pointer in words, for the earlier feedback the AI reads. */
function describePointer(value: unknown): string | null {
  const pointer = parsePointer(value);
  if (!pointer) return null;
  switch (pointer.kind) {
    case 'CHOICE':
      return `Choice ${pointer.label}`;
    case 'SECTION':
      return `the section "${pointer.heading}"`;
    case 'LINES':
      return pointer.from === pointer.to
        ? `line ${pointer.from}`
        : `lines ${pointer.from}–${pointer.to}`;
  }
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The part of the current Redraft a pointer names, with its text, for the AI: 422 when
 * it names a part the proposal doesn't have, or a kind of part this proposal can't have.
 */
export function pointerText(
  content: RedraftContent,
  pointer: RedraftPointer | null,
): string | null {
  if (!pointer) return null;
  switch (pointer.kind) {
    case 'CHOICE': {
      if (content.kind !== 'CHOICES') {
        throw new UnprocessableEntityException('Only Choices can be pointed at by a Choice');
      }
      const choice = content.choices.find(
        (c) => c.label.toUpperCase() === pointer.label.toUpperCase(),
      );
      if (!choice) throw new UnprocessableEntityException(`There is no Choice ${pointer.label}`);
      return [
        `Choice ${choice.label}: ${choice.title}`,
        choice.description,
        `Scope: ${choice.impactScope}`,
        `Time: ${choice.impactTime}`,
        `Risk: ${choice.impactRisk}`,
      ].join('\n');
    }
    case 'SECTION':
    case 'LINES': {
      if (content.kind !== 'MARKDOWN') {
        throw new UnprocessableEntityException(
          'Only a Spec Proposal or a Brief Proposal can be pointed at by a section or lines',
        );
      }
      const lines = content.markdown.replace(/\r\n?/g, '\n').split('\n');
      if (pointer.kind === 'LINES') {
        if (pointer.to > lines.length) {
          throw new UnprocessableEntityException(
            `The proposal has ${lines.length} lines, so there is no line ${pointer.to}`,
          );
        }
        const range =
          pointer.from === pointer.to
            ? `Line ${pointer.from}`
            : `Lines ${pointer.from}–${pointer.to}`;
        return `${range}:\n${lines.slice(pointer.from - 1, pointer.to).join('\n')}`;
      }
      const wanted = pointer.heading
        .replace(/^#+\s*/, '')
        .trim()
        .toLowerCase();
      const start = lines.findIndex((l) => HEADING.exec(l)?.[2]?.trim().toLowerCase() === wanted);
      if (start < 0) {
        throw new UnprocessableEntityException(`There is no section "${pointer.heading}"`);
      }
      const level = HEADING.exec(lines[start] ?? '')?.[1]?.length ?? 1;
      let end = start + 1;
      while (end < lines.length) {
        const h = HEADING.exec(lines[end] ?? '');
        if (h?.[1] && h[1].length <= level) break;
        end++;
      }
      return `The section "${pointer.heading}":\n${lines.slice(start, end).join('\n').trimEnd()}`;
    }
  }
}

function viewOf(
  content: RedraftContent,
  createdAt: Date,
  model: RecordedModelColumns | null,
): RedraftView {
  return {
    number: 1,
    status: 'READY',
    content,
    text: redraftText(content),
    feedback: null,
    pointer: null,
    requestedBy: null,
    summary: null,
    preferences: [],
    draftedWith: fromRecordedModelColumns(model),
    createdAt: createdAt.toISOString(),
  };
}

function firstView(target: Target): RedraftView {
  return viewOf(target.content, target.draftedAt, target.draftedWith);
}

function toRedraftView(row: RedraftRow): RedraftView {
  const parsed = row.content ? RedraftContent.safeParse(row.content) : null;
  const content = parsed?.success ? parsed.data : null;
  return {
    number: row.number,
    status: row.status,
    content,
    text: content ? redraftText(content) : '',
    feedback: row.feedback,
    pointer: parsePointer(row.pointer),
    requestedBy: row.requestedBy,
    summary: row.summary,
    preferences: row.preferences,
    draftedWith: fromRecordedModelColumns(row),
    createdAt: row.createdAt.toISOString(),
  };
}
