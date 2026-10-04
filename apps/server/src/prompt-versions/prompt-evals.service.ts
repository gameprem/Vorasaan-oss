import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import type {
  PromptEvalCaseView,
  PromptEvalCheck,
  PromptEvalComparison,
  PromptEvalRunSummary,
  PromptEvalRunView,
  PromptEvalSetScore,
  PromptEvalSource,
  PromptEvalUsage,
  StartPromptEvalInput,
} from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import { AI_PORT, type AiCallOptions, type AiPort, type PromptChoice } from '../ai/ai.port.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { failedCheck, scoreOutput } from '../evals/eval-case.ts';
import { casesForPrompt } from '../evals/eval-sets.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { receiptError } from '../receipts/redact.ts';
import { PromptVersionsService } from './prompt-versions.service.ts';
import { PromptReplay, REPLAYABLE } from './replay.ts';

/** One case of a run, whatever its source: what to call, and how to score the output. */
type RunnableCase = {
  key: string;
  set: string;
  name: string;
  language: AiCallOptions['language'];
  receiptId: string | null;
  run: (ai: AiPort, options: AiCallOptions) => Promise<unknown>;
  score: (output: unknown) => { score: number; checks: PromptEvalCheck[] };
};

const person = { select: { id: true, name: true } } as const;
const runInclude = {
  startedBy: person,
  version: { select: { number: true } },
} as const satisfies Prisma.PromptEvalRunInclude;
type RunRow = Prisma.PromptEvalRunGetPayload<{ include: typeof runInclude }>;
type CaseRow = Prisma.PromptEvalCaseGetPayload<object>;

const RESTARTED = 'Stopped when the server restarted';

/**
 * Eval runs on a version of a prompt (ADR 0015, ticket 0071), started by an Admin from
 * Settings → AI → Prompts: its checked-in eval cases, a replay of its approved Receipts,
 * or both, on the Approved Model the Admin picks. A run is a background job: `start`
 * returns at once and the cases run one after another, each stored with its score as it
 * ends, so the run shows its progress. Every call goes through the AI port with the
 * version under evaluation, so it leaves a Receipt marked with the run; the run's tokens
 * are summed from them.
 */
@Injectable()
export class PromptEvalsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PromptEvals');
  private readonly running = new Set<Promise<void>>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @Inject(AI_PORT) private readonly ai: AiPort,
    @InjectClock() private readonly clock: Clock,
    private readonly versions: PromptVersionsService,
    private readonly replay: PromptReplay,
    private readonly models: AiSettingsService,
    private readonly receipts: ReceiptsService,
  ) {}

  /** A run left RUNNING by a server that stopped will never end: mark it failed. */
  async onApplicationBootstrap() {
    await this.db.promptEvalRun.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', error: RESTARTED, finishedAt: this.clock.now() },
    });
  }

  async onApplicationShutdown() {
    await this.drain();
  }

  /** Waits for every run in progress (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  // ─── Starting ─────────────────────────────────────────────────────────────

  async start(
    user: User,
    name: SkillName,
    input: StartPromptEvalInput,
  ): Promise<PromptEvalRunSummary> {
    const organizationId = await this.versions.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    const prompt = await this.versions.resolve(name, input.version);
    const approved = await this.db.approvedModel.findFirst({
      where: { id: input.approvedModelId, organizationId },
      select: { id: true, displayName: true, modelId: true },
    });
    if (!approved) throw new UnprocessableEntityException('Pick one of the Approved Models');
    const sources = [...new Set(input.sources)];
    const cases = await this.casesFor(name, sources, input.approvedModelId);
    if (!cases.length) {
      throw new UnprocessableEntityException(
        sources.includes('REPLAY') && sources.length === 1
          ? 'No approved Receipts of this prompt can be replayed yet'
          : 'This prompt has no eval cases yet',
      );
    }
    const row = await this.db.promptEvalRun.create({
      data: {
        organizationId,
        promptName: name,
        versionId: prompt.number ? await this.versionId(organizationId, name, prompt.number) : null,
        promptVersion: prompt.version,
        approvedModelId: approved.id,
        modelDisplayName: approved.displayName,
        modelName: approved.modelId,
        sources,
        total: cases.length,
        startedById: user.id,
      },
      include: runInclude,
    });
    this.track(this.execute(row.id, user.id, prompt, approved.id, cases));
    return this.summary(row, []);
  }

  private async versionId(organizationId: string, name: SkillName, number: number) {
    const row = await this.db.promptVersion.findUnique({
      where: { organizationId_promptName_number: { organizationId, promptName: name, number } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** The cases of a run: the checked-in ones first, then the replay, each scored its own way. */
  private async casesFor(
    name: SkillName,
    sources: PromptEvalSource[],
    approvedModelId: string,
  ): Promise<RunnableCase[]> {
    const cases: RunnableCase[] = [];
    if (sources.includes('CHECKED_IN')) {
      for (const c of casesForPrompt(name)) {
        cases.push({
          key: c.key,
          set: c.set,
          name: c.name,
          language: c.lang?.language,
          receiptId: null,
          run: c.run,
          score: (output) => scoreOutput(c, output),
        });
      }
    }
    if (sources.includes('REPLAY')) {
      const task = REPLAYABLE[name];
      const model = task ? await this.models.chooseModel(task, approvedModelId) : undefined;
      for (const c of await this.replay.cases(name, model)) {
        cases.push({ ...c, receiptId: c.receiptId });
      }
    }
    return cases;
  }

  private track(work: Promise<void>) {
    const running = work.catch((error) =>
      this.logger.error(`An eval run failed: ${(error as Error)?.message ?? error}`),
    );
    this.running.add(running);
    void running.finally(() => this.running.delete(running));
  }

  /** Runs the cases one by one, storing each as it ends, then sums the run up. */
  private async execute(
    runId: string,
    userId: string,
    prompt: PromptChoice,
    approvedModelId: string,
    cases: RunnableCase[],
  ): Promise<void> {
    try {
      for (const [position, c] of cases.entries()) {
        const started = performance.now();
        let output: unknown = null;
        let error: string | null = null;
        let scored: { score: number; checks: PromptEvalCheck[] };
        try {
          output = await c.run(this.ai, {
            approvedModelId,
            prompt,
            ...(c.language ? { language: c.language } : {}),
            receipt: { requestedById: userId, evalRunId: runId },
          });
          scored = c.score(output);
        } catch (failure) {
          error = receiptError(failure);
          output = null;
          scored = failedCheck(error);
        }
        await this.db.$transaction([
          this.db.promptEvalCase.create({
            data: {
              runId,
              position,
              set: c.set,
              caseKey: c.key,
              name: c.name,
              score: scored.score,
              checks: scored.checks,
              output: output === null ? undefined : (JSON.parse(JSON.stringify(output)) as object),
              error,
              receiptId: c.receiptId,
              latencyMs: Math.max(0, Math.round(performance.now() - started)),
            },
          }),
          this.db.promptEvalRun.update({ where: { id: runId }, data: { done: { increment: 1 } } }),
        ]);
      }
      const scores = await this.db.promptEvalCase.aggregate({
        where: { runId },
        _avg: { score: true },
      });
      await this.db.promptEvalRun.update({
        where: { id: runId },
        data: {
          status: 'DONE',
          score: scores._avg.score ?? 0,
          ...(await this.usageFromReceipts(runId)),
          finishedAt: this.clock.now(),
        },
      });
    } catch (error) {
      await this.db.promptEvalRun
        .update({
          where: { id: runId },
          data: {
            status: 'FAILED',
            error: receiptError(error),
            ...(await this.usageFromReceipts(runId).catch(() => ({}))),
            finishedAt: this.clock.now(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /** The tokens of a run's calls, summed from their Receipts (once every write has landed). */
  private async usageFromReceipts(runId: string): Promise<PromptEvalUsage> {
    await this.receipts.drain();
    const sum = await this.db.receipt.aggregate({
      where: { evalRunId: runId },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    });
    return {
      inputTokens: sum._sum.inputTokens,
      outputTokens: sum._sum.outputTokens,
      cacheReadTokens: sum._sum.cacheReadTokens,
      cacheWriteTokens: sum._sum.cacheWriteTokens,
    };
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** A prompt's runs, newest first, with their scores per set. */
  async runs(name: SkillName): Promise<PromptEvalRunSummary[]> {
    const organizationId = await this.versions.organizationId();
    if (!organizationId) return [];
    const rows = await this.db.promptEvalRun.findMany({
      where: { organizationId, promptName: name },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: runInclude,
    });
    const cases = await this.db.promptEvalCase.findMany({
      where: { runId: { in: rows.map((r) => r.id) } },
      select: { runId: true, set: true, score: true },
    });
    return Promise.all(
      rows.map((row) =>
        this.summary(
          row,
          cases.filter((c) => c.runId === row.id),
        ),
      ),
    );
  }

  async run(name: SkillName, runId: string): Promise<PromptEvalRunView> {
    const { row, cases } = await this.findRun(name, runId);
    return { ...(await this.summary(row, cases)), cases: cases.map(caseView) };
  }

  /** Two runs side by side: their scores per eval set and per case, with sample outputs. */
  async compare(name: SkillName, a: string, b: string): Promise<PromptEvalComparison> {
    const [left, right] = await Promise.all([this.findRun(name, a), this.findRun(name, b)]);
    const sets = [...new Set([...left.cases, ...right.cases].map((c) => c.set))];
    const keys = new Map<string, CaseRow>();
    for (const c of [...left.cases, ...right.cases])
      if (!keys.has(c.caseKey)) keys.set(c.caseKey, c);
    const side = (cases: CaseRow[], key: string) => {
      const c = cases.find((x) => x.caseKey === key);
      return c
        ? {
            score: c.score,
            checks: c.checks as PromptEvalCheck[],
            output: c.output ?? null,
            error: c.error,
          }
        : null;
    };
    const setScore = (cases: CaseRow[], set: string) => mean(cases.filter((c) => c.set === set));
    return {
      a: await this.summary(left.row, left.cases),
      b: await this.summary(right.row, right.cases),
      sets: sets.map((set) => ({
        set,
        a: setScore(left.cases, set),
        b: setScore(right.cases, set),
      })),
      cases: [...keys.values()].map((c) => ({
        key: c.caseKey,
        set: c.set,
        name: c.name,
        a: side(left.cases, c.caseKey),
        b: side(right.cases, c.caseKey),
      })),
    };
  }

  private async findRun(name: SkillName, runId: string) {
    const organizationId = await this.versions.organizationId();
    const row = organizationId
      ? await this.db.promptEvalRun.findFirst({
          where: { id: runId, organizationId, promptName: name },
          include: runInclude,
        })
      : null;
    if (!row) throw new NotFoundException('No such eval run of this prompt');
    const cases = await this.db.promptEvalCase.findMany({
      where: { runId },
      orderBy: { position: 'asc' },
    });
    return { row, cases };
  }

  private async summary(
    row: RunRow,
    cases: { set: string; score: number }[],
  ): Promise<PromptEvalRunSummary> {
    const usage: PromptEvalUsage =
      row.status === 'RUNNING'
        ? await this.usageFromReceipts(row.id)
        : {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
          };
    const sets = [...new Set(cases.map((c) => c.set))];
    return {
      id: row.id,
      promptName: row.promptName,
      number: row.version?.number ?? 0,
      version: row.promptVersion,
      model: {
        approvedModelId: row.approvedModelId,
        displayName: row.modelDisplayName,
        name: row.modelName,
      },
      sources: row.sources as PromptEvalSource[],
      status: row.status,
      total: row.total,
      done: row.done,
      score: row.score,
      setScores: sets.map(
        (set): PromptEvalSetScore => ({
          set,
          score: mean(cases.filter((c) => c.set === set)),
          cases: cases.filter((c) => c.set === set).length,
        }),
      ),
      error: row.error,
      usage,
      startedBy: row.startedBy,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}

function mean(cases: { score: number }[]): number | null {
  if (!cases.length) return null;
  return cases.reduce((sum, c) => sum + c.score, 0) / cases.length;
}

function caseView(c: CaseRow): PromptEvalCaseView {
  return {
    key: c.caseKey,
    set: c.set,
    name: c.name,
    score: c.score,
    checks: c.checks as PromptEvalCheck[],
    output: c.output ?? null,
    error: c.error,
    receiptId: c.receiptId,
    latencyMs: c.latencyMs,
  };
}
