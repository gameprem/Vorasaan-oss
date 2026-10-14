import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  DEFAULT_PROMPT_ANALYSIS_AFTER,
  DEFAULT_PROMPT_NUMBER,
  type PromptAnalysisTrigger,
  type PromptAnalysisView,
  type PromptEvalSource,
  type PromptFeedbackView,
  type PromptPattern,
  type PromptProposalView,
  type ProposalKind,
} from '@vorasaan/shared';
import { isSkillName, type SkillName } from '@vorasaan/skills';
import {
  AI_PORT,
  type AiPort,
  type FeedbackAnalysis,
  type FeedbackCaseForAi,
} from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { asReplyLanguage, personLanguage, type ReplyLanguage } from '../ai/language.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { casesForPrompt } from '../evals/eval-sets.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { receiptError } from '../receipts/redact.ts';
import { RedraftsService } from '../redrafts/redrafts.service.ts';
import {
  forStorage,
  MIN_PATTERN_CASES,
  patternsForAi,
  type StoredPattern,
  type StoredPatternCase,
  storedPatterns,
  withCaseTexts,
} from './patterns.ts';
import { PromptEvalsService } from './prompt-evals.service.ts';
import { PromptVersionsService, tasksOf } from './prompt-versions.service.ts';
import { PromptReplay, REPLAYABLE } from './replay.ts';

/** The most outcomes one analysis reads: the newest. */
export const MAX_ANALYSIS_OUTCOMES = 200;

/** Analyses listed on a prompt's page, newest first. */
const LISTED_ANALYSES = 10;

const RESTARTED = 'Stopped when the server restarted';

const person = { select: { id: true, name: true } } as const;
const analysisInclude = {
  requestedBy: person,
  version: { select: { number: true } },
} as const satisfies Prisma.PromptAnalysisInclude;
type AnalysisRow = Prisma.PromptAnalysisGetPayload<{ include: typeof analysisInclude }>;

const outcomeSelect = {
  id: true,
  receiptId: true,
  kind: true,
  proposalKind: true,
  proposalId: true,
  redraft: true,
  reason: true,
  redraftsBeforeApproval: true,
  choiceLabel: true,
  editSize: true,
  createdAt: true,
} as const satisfies Prisma.ReceiptOutcomeSelect;
type OutcomeRow = Prisma.ReceiptOutcomeGetPayload<{ select: typeof outcomeSelect }>;

/**
 * The outcomes of a prompt (ticket 0072): those linked to a Receipt of a call that rendered
 * it, whether the call drafted the proposal or wrote one of its Redrafts. An Eval Run's own
 * calls never count.
 */
function outcomesOf(name: SkillName): Prisma.ReceiptOutcomeWhereInput {
  return {
    OR: [
      { receipt: { promptName: name, evalRunId: null } },
      { redraftReceipt: { promptName: name, evalRunId: null } },
    ],
  };
}

/**
 * The AI proposes better prompts (ADR 0015, ticket 0072). An analysis reads the outcomes
 * linked to one prompt's Receipts and names the patterns in them, each citing its cases;
 * from them the AI proposes a Prompt Version with its rationale, and evals run on it and on
 * the version active now, on the task's Approved Model. An analysis runs when an Admin asks,
 * or once a prompt has enough new outcomes (`promptAnalysisAfter`, 20 by default).
 *
 * It never publishes anything: the proposal is a PROPOSED Prompt Version like one written by
 * hand, and only an Admin's Approve makes it active, whatever its scores. Request changes
 * writes its next Redraft (`RedraftsService`, `PROMPT_VERSION`), and its evals run again.
 */
@Injectable()
export class PromptProposalsService
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('PromptProposals');
  private readonly running = new Set<Promise<unknown>>();
  /** Prompts being checked for new feedback, so one burst of outcomes starts one analysis. */
  private readonly checking = new Set<string>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    @InjectClock() private readonly clock: Clock,
    private readonly versions: PromptVersionsService,
    private readonly evals: PromptEvalsService,
    private readonly replay: PromptReplay,
    private readonly models: AiSettingsService,
    private readonly receipts: ReceiptsService,
    private readonly redrafts: RedraftsService,
  ) {}

  onModuleInit() {
    // Enough new feedback on a prompt: the AI reads it (unless one is waiting already).
    this.receipts.onOutcome((names) => {
      for (const name of names) this.track(this.checkFeedback(name));
    });
    // A Redraft of a proposal is ready: its evals run again.
    this.redrafts.listen((event) => {
      if (event.kind !== 'PROMPT_VERSION' || event.status !== 'READY') return;
      this.track(this.rerunEvals(event.proposalId, event.number));
    });
  }

  /** An analysis left RUNNING by a server that stopped will never end: mark it failed. */
  async onApplicationBootstrap() {
    await this.db.promptAnalysis.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', error: RESTARTED, finishedAt: this.clock.now() },
    });
  }

  async onApplicationShutdown() {
    await this.drain();
  }

  /**
   * Waits until nothing of the Learning Loop is in flight (tests, shutdown): analyses, the
   * evals they start, and the Receipts and outcomes those leave, which may start more.
   */
  async drain(): Promise<void> {
    for (;;) {
      await this.receipts.drain();
      if (this.running.size) {
        await Promise.allSettled([...this.running]);
        continue;
      }
      await this.evals.drain();
      await this.receipts.drain();
      if (!this.running.size) return;
    }
  }

  private track(work: Promise<unknown>) {
    const running = work.catch((error) =>
      this.logger.error(`Prompt proposals: ${(error as Error)?.message ?? error}`),
    );
    this.running.add(running);
    void running.finally(() => this.running.delete(running));
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async analysisAfter(): Promise<number> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { promptAnalysisAfter: true },
    });
    return org?.promptAnalysisAfter ?? DEFAULT_PROMPT_ANALYSIS_AFTER;
  }

  async setAnalysisAfter(analysisAfter: number): Promise<{ analysisAfter: number }> {
    const organizationId = await this.versions.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    await this.db.organization.update({
      where: { id: organizationId },
      data: { promptAnalysisAfter: analysisAfter },
    });
    return { analysisAfter };
  }

  // ─── Analysing ────────────────────────────────────────────────────────────

  /**
   * Starts an analysis of the prompt's feedback in the background and returns it, RUNNING:
   * 422 with no outcomes to read, 409 while another analysis of it runs.
   */
  async analyze(
    user: User | null,
    name: SkillName,
    trigger: PromptAnalysisTrigger = 'MANUAL',
  ): Promise<PromptAnalysisView> {
    const organizationId = await this.versions.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    const outcomes = (
      await this.db.receiptOutcome.findMany({
        where: outcomesOf(name),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_ANALYSIS_OUTCOMES,
        select: outcomeSelect,
      })
    ).reverse();
    if (!outcomes.length) {
      throw new UnprocessableEntityException(
        'Nobody has approved, declined or asked for changes to what this prompt proposed yet, so there is no feedback to read',
      );
    }
    let row: AnalysisRow;
    try {
      row = await this.db.promptAnalysis.create({
        data: {
          organizationId,
          promptName: name,
          trigger,
          outcomes: outcomes.length,
          requestedById: user?.id ?? null,
          createdAt: this.clock.now(),
        },
        include: analysisInclude,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException('The AI is already reading the feedback on this prompt');
      }
      throw error;
    }
    this.track(this.execute(row.id, user?.id ?? null, name, outcomes));
    return this.analysisView(row);
  }

  /** Analyses the prompt when it has enough new outcomes and nothing of it is waiting. */
  private async checkFeedback(name: string): Promise<void> {
    if (!isSkillName(name) || this.checking.has(name)) return;
    this.checking.add(name);
    try {
      const after = await this.analysisAfter();
      if (after <= 0) return;
      const organizationId = await this.versions.organizationId();
      if (!organizationId) return;
      const [running, waiting] = await Promise.all([
        this.db.promptAnalysis.count({
          where: { organizationId, promptName: name, status: 'RUNNING' },
        }),
        this.db.promptVersion.count({
          where: {
            organizationId,
            promptName: name,
            status: 'PROPOSED',
            analysisId: { not: null },
          },
        }),
      ]);
      if (running || waiting) return;
      if ((await this.newOutcomes(name)) < after) return;
      await this.analyze(null, name, 'FEEDBACK').catch((error) => {
        // Another analysis got there first: nothing to do.
        if (!(error instanceof ConflictException)) throw error;
      });
    } finally {
      this.checking.delete(name);
    }
  }

  /** Outcomes of the prompt since its last analysis that didn't fail (all of them before one). */
  private async newOutcomes(name: SkillName): Promise<number> {
    const organizationId = await this.versions.organizationId();
    const last = organizationId
      ? await this.db.promptAnalysis.findFirst({
          where: { organizationId, promptName: name, status: { not: 'FAILED' } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
      : null;
    return this.db.receiptOutcome.count({
      where: {
        ...outcomesOf(name),
        ...(last ? { createdAt: { gt: last.createdAt } } : {}),
      },
    });
  }

  /** The analysis, then the proposal and its evals; a failure is stored on the analysis. */
  private async execute(
    analysisId: string,
    requestedById: string | null,
    name: SkillName,
    outcomes: OutcomeRow[],
  ): Promise<void> {
    try {
      const prompt = { name, tasks: tasksOf(name) };
      const active = await this.versions.active(name);
      const [template, language, calls] = await Promise.all([
        this.versions.template(name, active.number),
        this.languageFor(requestedById),
        this.db.receipt.count({ where: { promptName: name, evalRunId: null } }),
      ]);
      const cases = outcomes.map(
        (o, i): FeedbackCaseForAi => ({
          index: i + 1,
          outcome: o.kind,
          proposal: o.proposalKind,
          redraft: o.redraft,
          text: o.reason,
          redraftsBeforeApproval: o.redraftsBeforeApproval,
          choiceLabel: o.choiceLabel,
          editSize: o.editSize,
        }),
      );
      const analysis = await this.ai.analyzeFeedback(
        { prompt, template, calls, cases },
        {
          language,
          receipt: { requestedById, output: { kind: 'PROMPT_ANALYSIS', id: analysisId } },
        },
      );
      const patterns = toStoredPatterns(analysis, outcomes);
      if (!patterns.length) {
        await this.finish(analysisId, { patterns });
        return;
      }

      // The proposal: a Prompt Version of the active one, whose id its Receipt names.
      const versionId = randomUUID();
      const proposed = await this.ai.proposePromptVersion(
        {
          prompt,
          template,
          placeholders: await this.versions.requiredPlaceholders(name),
          patterns: patternsForAi(patterns),
        },
        {
          language,
          receipt: {
            requestedById,
            output: { kind: 'PROMPT_VERSION', id: versionId },
            proposal: { kind: 'PROMPT_VERSION', id: versionId, redraft: 1 },
          },
        },
      );
      const proposedTemplate = `${proposed.template.trim()}\n`;
      try {
        await this.versions.assertRenders(name, proposedTemplate);
      } catch (error) {
        await this.finish(analysisId, {
          patterns,
          error: `The AI proposed a version that can't be used as this prompt: ${(error as Error).message}`,
        });
        return;
      }
      if (proposedTemplate.trim() === template.trim()) {
        await this.finish(analysisId, { patterns });
        return;
      }
      const version = await this.createVersion(
        versionId,
        name,
        analysisId,
        proposedTemplate,
        proposed.rationale,
      );
      await this.finish(analysisId, { patterns });
      await this.runEvals(version.id, requestedById);
    } catch (error) {
      await this.finish(analysisId, { error: receiptError(error) }).catch(() => undefined);
      throw error;
    }
  }

  private async finish(
    analysisId: string,
    result: { patterns?: StoredPattern[]; error?: string },
  ): Promise<void> {
    await this.db.promptAnalysis.update({
      where: { id: analysisId },
      data: {
        status: result.error ? 'FAILED' : 'DONE',
        ...(result.patterns ? { patterns: forStorage(result.patterns) } : {}),
        error: result.error ?? null,
        finishedAt: this.clock.now(),
      },
    });
  }

  /** The Prompt Version the AI proposed: numbered next, PROPOSED, with nobody as its writer. */
  private async createVersion(
    id: string,
    name: SkillName,
    analysisId: string,
    template: string,
    rationale: string,
  ) {
    const organizationId = await this.versions.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    for (let attempt = 0; ; attempt++) {
      const last = await this.db.promptVersion.findFirst({
        where: { organizationId, promptName: name },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      try {
        return await this.db.promptVersion.create({
          data: {
            id,
            organizationId,
            promptName: name,
            number: (last?.number ?? 0) + 1,
            template,
            rationale,
            analysisId,
            createdAt: this.clock.now(),
          },
        });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== 'P2002' || attempt >= 2) throw error;
      }
    }
  }

  /** The Reply Language of whoever asked; for an analysis nobody asked for, the Organization's. */
  private async languageFor(userId: string | null): Promise<ReplyLanguage | undefined> {
    if (userId) return personLanguage(this.db, userId);
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { language: true },
    });
    return asReplyLanguage(org?.language) ?? undefined;
  }

  // ─── Evals of a proposal ──────────────────────────────────────────────────

  /**
   * Runs evals on the proposal and on the version active now, on the Approved Model of the
   * prompt's task, with every source the prompt has: its checked-in cases and a replay. The
   * runs replace the proposal's earlier ones (a Redraft is evaluated afresh). Nothing runs
   * without an Approved Model or without any case.
   */
  private async runEvals(versionId: string, startedById: string | null): Promise<void> {
    const plan = await this.evalPlan(versionId);
    if ('note' in plan) return;
    const { version, approvedModelId, sources } = plan;
    const name = version.promptName as SkillName;
    const active = await this.versions.active(name);
    const before = await this.evals.begin(startedById, name, {
      version: active.number,
      approvedModelId,
      sources,
    });
    const after = await this.evals.begin(startedById, name, {
      version: version.number,
      approvedModelId,
      sources,
    });
    await this.db.promptVersion.updateMany({
      where: { id: version.id, status: 'PROPOSED' },
      data: { evalRunId: after.id, baselineRunId: before.id },
    });
  }

  /** What evals a proposal gets: the model and the sources, or why it gets none. */
  private async evalPlan(versionId: string): Promise<
    | {
        version: { id: string; number: number; promptName: string };
        approvedModelId: string;
        sources: PromptEvalSource[];
      }
    | { note: string }
  > {
    const version = await this.db.promptVersion.findUnique({
      where: { id: versionId },
      select: { id: true, number: true, promptName: true, status: true },
    });
    if (!version || !isSkillName(version.promptName)) return { note: 'No such proposal' };
    const name = version.promptName;
    const sources: PromptEvalSource[] = [];
    if (casesForPrompt(name).length) sources.push('CHECKED_IN');
    if (REPLAYABLE[name] && (await this.replay.count(name)) > 0) sources.push('REPLAY');
    if (!sources.length) {
      return { note: 'This prompt has no eval cases and nothing to replay yet, so no evals ran.' };
    }
    const task = tasksOf(name)[0];
    const model = task ? await this.models.chooseModel(task) : null;
    if (!model?.approvedModelId) {
      return {
        note: 'No Approved Model runs this prompt, so no evals ran. Approve a model in AI models, then run evals here.',
      };
    }
    return { version, approvedModelId: model.approvedModelId, sources };
  }

  /** After Redraft `number` of a proposal is ready, as whoever asked for it. */
  private async rerunEvals(versionId: string, number: number): Promise<void> {
    const redraft = await this.db.redraft.findFirst({
      where: { proposalKind: 'PROMPT_VERSION', proposalId: versionId, number },
      select: { requestedById: true },
    });
    await this.runEvals(versionId, redraft?.requestedById ?? null);
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** A prompt's feedback: what is new since its last analysis, and its analyses. */
  async feedback(name: SkillName): Promise<PromptFeedbackView> {
    const organizationId = await this.versions.organizationId();
    const [newOutcomes, outcomes, analysisAfter, rows] = await Promise.all([
      this.newOutcomes(name),
      this.db.receiptOutcome.count({ where: outcomesOf(name) }),
      this.analysisAfter(),
      organizationId
        ? this.db.promptAnalysis.findMany({
            where: { organizationId, promptName: name },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: LISTED_ANALYSES,
            include: analysisInclude,
          })
        : [],
    ]);
    return {
      newOutcomes,
      outcomes,
      analysisAfter,
      analyses: await Promise.all(rows.map((row) => this.analysisView(row))),
    };
  }

  /** New outcomes per prompt since each one's last analysis, for the list of prompts. */
  async newOutcomesByPrompt(names: readonly SkillName[]): Promise<Map<string, number>> {
    const counts = await Promise.all(
      names.map(async (n) => [n, await this.newOutcomes(n)] as const),
    );
    return new Map(counts);
  }

  /**
   * A Prompt Version the AI proposed, as an Admin decides it: the analysis behind it, the diff
   * from the version active now, and the evals on both side by side. 404 for one written by
   * hand.
   */
  async proposal(name: SkillName, number: number): Promise<PromptProposalView> {
    const row = await this.versions.findVersion(name, number);
    if (!row.analysisId) {
      throw new NotFoundException(`v${number} was written by hand, not proposed by the AI`);
    }
    const active = await this.versions.active(name);
    const [version, analysisRow, before, after] = await Promise.all([
      this.versions.view(row, active.number),
      this.db.promptAnalysis.findUnique({
        where: { id: row.analysisId },
        include: analysisInclude,
      }),
      this.evals.summaryOf(name, row.baselineRunId),
      this.evals.summaryOf(name, row.evalRunId),
    ]);
    // From the version it was evaluated against (active when it was proposed or redrafted).
    const base = before?.number ?? active.number;
    const diff = await this.versions.diff(
      name,
      base === number ? DEFAULT_PROMPT_NUMBER : base,
      number,
    );
    const comparison =
      before?.status === 'DONE' && after?.status === 'DONE'
        ? await this.evals.compare(name, before.id, after.id)
        : null;
    let evalsNote: string | null = null;
    if (!before && !after) {
      const plan = await this.evalPlan(row.id);
      evalsNote = 'note' in plan ? plan.note : null;
    }
    return {
      version,
      analysis: analysisRow ? await this.analysisView(analysisRow) : null,
      activeNumber: active.number,
      diff,
      before,
      after,
      comparison,
      evalsNote,
    };
  }

  private async analysisView(row: AnalysisRow): Promise<PromptAnalysisView> {
    const stored = await withCaseTexts(this.db, storedPatterns(row.patterns));
    const hrefs = await this.hrefs(stored.flatMap((p) => p.cases));
    return {
      id: row.id,
      promptName: row.promptName,
      trigger: row.trigger,
      status: row.status,
      outcomes: row.outcomes,
      patterns: stored.map(
        (p): PromptPattern => ({
          title: p.title,
          description: p.description,
          count: p.count,
          cases: p.cases.map((c) => ({
            outcomeId: c.outcomeId,
            receiptId: c.receiptId,
            kind: c.kind,
            text: c.text ?? null,
            redraft: c.redraft,
            proposal: { kind: c.proposalKind, id: c.proposalId },
            href: hrefs.get(`${c.proposalKind}:${c.proposalId}`) ?? null,
            at: c.at,
          })),
        }),
      ),
      error: row.error,
      proposed: row.version?.number ?? null,
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  /**
   * The web app's path to each case's proposal, by `<kind>:<id>`; a proposal that is gone
   * has none. A few queries, whatever the number of cases.
   */
  private async hrefs(cases: StoredPatternCase[]): Promise<Map<string, string>> {
    const ids = (kind: ProposalKind) => [
      ...new Set(cases.filter((c) => c.proposalKind === kind).map((c) => c.proposalId)),
    ];
    const [requests, specs, briefs, suggestions, versions, designDocs] = await Promise.all([
      this.db.decisionRequest.findMany({
        where: { id: { in: ids('CHOICES') } },
        select: { id: true },
      }),
      this.db.specProposal.findMany({
        where: { id: { in: ids('SPEC_PROPOSAL') } },
        select: { id: true, featureId: true },
      }),
      this.db.briefProposal.findMany({
        where: { id: { in: ids('BRIEF_PROPOSAL') } },
        select: { id: true, projectId: true },
      }),
      this.db.featureSuggestion.findMany({
        where: { id: { in: ids('FEATURE_SUGGESTION') } },
        select: { id: true, projectId: true },
      }),
      this.db.promptVersion.findMany({
        where: { id: { in: ids('PROMPT_VERSION') } },
        select: { id: true, promptName: true, number: true, analysisId: true },
      }),
      this.db.designDocProposal.findMany({
        where: { id: { in: ids('DESIGN_DOC_PROPOSAL') } },
        select: { id: true, designDoc: { select: { featureId: true, platformId: true } } },
      }),
    ]);
    const out = new Map<string, string>();
    for (const r of requests) out.set(`CHOICES:${r.id}`, `/requests/${r.id}`);
    for (const p of specs) {
      out.set(`SPEC_PROPOSAL:${p.id}`, `/features/${p.featureId}/proposals/${p.id}`);
    }
    for (const p of briefs) out.set(`BRIEF_PROPOSAL:${p.id}`, `/projects/${p.projectId}`);
    for (const s of suggestions) out.set(`FEATURE_SUGGESTION:${s.id}`, `/projects/${s.projectId}`);
    for (const p of designDocs) {
      out.set(
        `DESIGN_DOC_PROPOSAL:${p.id}`,
        `/features/${p.designDoc.featureId}/design-docs/${p.designDoc.platformId ?? 'qa'}`,
      );
    }
    for (const v of versions) {
      out.set(
        `PROMPT_VERSION:${v.id}`,
        v.analysisId
          ? `/settings/ai/prompts/${v.promptName}/proposals/${v.number}`
          : `/settings/ai/prompts/${v.promptName}`,
      );
    }
    return out;
  }
}

/**
 * The AI's patterns as stored: each case number mapped back to its outcome (an unknown or
 * repeated number is dropped), patterns with fewer than MIN_PATTERN_CASES left out, the
 * most cases first.
 */
export function toStoredPatterns(
  analysis: FeedbackAnalysis,
  outcomes: OutcomeRow[],
): StoredPattern[] {
  return analysis.patterns
    .map((p): StoredPattern => {
      const indices = [...new Set(p.cases)].filter((i) => i >= 1 && i <= outcomes.length);
      const cases = indices
        .sort((a, b) => a - b)
        .map((i): StoredPatternCase | null => {
          const o = outcomes[i - 1];
          return o
            ? {
                outcomeId: o.id,
                receiptId: o.receiptId,
                kind: o.kind,
                proposalKind: o.proposalKind,
                proposalId: o.proposalId,
                redraft: o.redraft,
                text: o.reason,
                at: o.createdAt.toISOString(),
              }
            : null;
        })
        .filter((c): c is StoredPatternCase => c !== null);
      return { title: p.title, description: p.description, count: cases.length, cases };
    })
    .filter((p) => p.count >= MIN_PATTERN_CASES)
    .sort((a, b) => b.count - a.count);
}
