import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { diffLines, type PromptEvalCheck, REPLAY_EVAL_SET } from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import type { AiTask } from '../ai/ai.config.ts';
import type {
  AiCallOptions,
  AiPort,
  DecisionForAi,
  GeneratedChoices,
  ModelChoice,
  SpecProposalDraft,
} from '../ai/ai.port.ts';
import { ContextBudgets } from '../ai/context-budget.ts';
import { asReplyLanguage } from '../ai/language.ts';
import { describeDecision } from '../ai/prompts.ts';
import { CoverageService } from '../coverage/coverage.service.ts';
import { allText } from '../evals/eval-case.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ContextRetriever, splitFeatureSpec } from '../retrieval/context-retriever.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';

/** The most approved Receipts one replay runs, newest first. */
export const MAX_REPLAY_CASES = 20;

/** The prompts whose approved Receipts can be replayed, and the task each replays. */
export const REPLAYABLE: Partial<Record<SkillName, AiTask>> = {
  'generate-choices': 'generateChoices',
  'draft-spec-proposal': 'draftSpecProposal',
};

/** One approved Receipt, ready to run again and be scored against what was approved. */
export type ReplayCase = {
  key: string;
  set: typeof REPLAY_EVAL_SET;
  name: string;
  receiptId: string;
  task: AiTask;
  language: AiCallOptions['language'];
  run: (ai: AiPort, options: AiCallOptions) => Promise<unknown>;
  /** The output's similarity to the approved one: the case's score, and its checks. */
  score: (output: unknown) => { score: number; checks: PromptEvalCheck[] };
};

/** Words of a text, lowercased: what two outputs are compared by. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** How alike two texts are, by their words (Dice coefficient of word multisets), 0 to 1. */
export function wordSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.length && !right.length) return 1;
  const counts = new Map<string, number>();
  for (const w of left) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of right) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (left.length + right.length);
}

/** How alike two Markdown documents are, by their lines (unchanged lines over all), 0 to 1. */
export function lineSimilarity(a: string, b: string): number {
  const lines = diffLines(a, b);
  if (!lines.length) return 1;
  const same = lines.filter((l) => l.kind === 'UNCHANGED').length;
  const before = lines.filter((l) => l.kind !== 'ADDED').length;
  const after = lines.filter((l) => l.kind !== 'REMOVED').length;
  return (2 * same) / (before + after);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Whether an output counts as close to the approved one, for its check. */
const CLOSE_ENOUGH = 0.5;

/**
 * A replay of approved Receipts (ADR 0015, ticket 0071): for a prompt, the calls whose
 * proposal people approved, run again with the same inputs, rebuilt from the records the
 * Receipt points at, and scored by how close the output comes to the approved one.
 *
 * Receipts keep no prompt text, so a Receipt is replayed only while what it points at
 * still exists; one whose records were deleted (a Feature removed, or its proposal gone)
 * is left out, and Receipts past retention are gone already. Eval runs' own Receipts are
 * never picked. The Spec is the Spec Version current when the call was made; retrieved
 * context is retrieved again, without the request being replayed.
 */
@Injectable()
export class PromptReplay {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly budgets: ContextBudgets,
    private readonly coverage: CoverageService,
  ) {}

  /** The approved Receipts of a prompt a replay would consider, newest first. */
  private approvedReceipts(name: SkillName) {
    return this.db.receipt.findMany({
      where: {
        promptName: name,
        task: REPLAYABLE[name],
        success: true,
        evalRunId: null,
        redraft: 1,
        outcomes: { some: { kind: 'APPROVE' } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_REPLAY_CASES * 2,
      select: { id: true, proposalId: true, language: true, createdAt: true },
    });
  }

  /** The replay cases of a prompt: approved Receipts whose inputs still exist, newest first. */
  async cases(name: SkillName, model?: ModelChoice): Promise<ReplayCase[]> {
    const task = REPLAYABLE[name];
    if (!task) return [];
    const cases: ReplayCase[] = [];
    for (const receipt of await this.approvedReceipts(name)) {
      if (!receipt.proposalId) continue;
      const built =
        task === 'generateChoices'
          ? await this.choicesCase(receipt.proposalId, receipt.createdAt, model)
          : await this.specProposalCase(receipt.proposalId, model);
      if (!built) continue;
      cases.push({
        ...built,
        key: `${REPLAY_EVAL_SET}/${receipt.id}`,
        set: REPLAY_EVAL_SET,
        receiptId: receipt.id,
        task,
        language: asReplyLanguage(receipt.language) ?? undefined,
      });
      if (cases.length >= MAX_REPLAY_CASES) break;
    }
    return cases;
  }

  /** How many approved Receipts a replay of the prompt would pick now. */
  async count(name: SkillName): Promise<number> {
    return (await this.cases(name)).length;
  }

  /** The Spec Version of a Feature current at `at` (its Markdown; empty before v1). */
  private async specAt(featureId: string, at: Date): Promise<string> {
    const version = await this.db.specVersion.findFirst({
      where: { featureId, createdAt: { lte: at } },
      orderBy: { version: 'desc' },
      select: { markdown: true },
    });
    return version?.markdown ?? '';
  }

  private async raiserRole(request: { featureId: string; raiserId: string; deciderRole: string }) {
    const owner = await this.db.roleOwner.findFirst({
      where: { featureId: request.featureId, userId: request.raiserId },
      orderBy: { role: 'asc' },
      select: { role: true },
    });
    return (owner?.role ?? request.deciderRole) as Parameters<
      AiPort['generateChoices']
    >[0]['request']['raiserRole'];
  }

  /** The context and foundation the task gets, retrieved again without the request itself. */
  private async contextFor(
    task: AiTask,
    featureId: string,
    query: string,
    requestId: string,
    model: ModelChoice | undefined,
    fixed: number,
  ) {
    const { budget } = await this.budgets.forTask(task, 'decisionRequest', { model, fixed });
    const { foundation, contextBudget } = await this.foundation.forFeature(featureId, budget);
    const { context } = splitFeatureSpec(
      await this.retriever.forFeature(featureId, query, contextBudget, {
        excludeRequestId: requestId,
        k: budget.topK,
      }),
    );
    return { foundation, context: withoutBrief(context) };
  }

  /** Choices: the request as raised, scored against the Choices it was sent with. */
  private async choicesCase(requestId: string, at: Date, model: ModelChoice | undefined) {
    const request = await this.db.decisionRequest.findUnique({
      where: { id: requestId },
      include: { choices: { orderBy: { position: 'asc' } } },
    });
    if (!request?.choices.length) return null;
    const approved = request.choices.map((c) => ({
      label: c.label,
      title: c.title,
      description: c.description,
      impactScope: c.impactScope,
      impactTime: c.impactTime,
      impactRisk: c.impactRisk,
    }));
    const raiserRole = await this.raiserRole(request);
    const specMarkdown = await this.specAt(request.featureId, at);
    return {
      name: `Choices: ${request.title}`,
      run: async (ai: AiPort, options: AiCallOptions) => {
        const { foundation, context } = await this.contextFor(
          'generateChoices',
          request.featureId,
          `${request.title}\n\n${request.description}`,
          request.id,
          model,
          estimateTokens(specMarkdown),
        );
        return ai.generateChoices(
          {
            specMarkdown: specMarkdown || '(This Feature has no Spec yet.)',
            context,
            foundation,
            request: {
              kind: request.kind,
              title: request.title,
              description: request.description,
              raiserRole,
            },
          },
          options,
        );
      },
      score: (output: unknown) => {
        const choices = (output as GeneratedChoices).choices;
        const similarity = wordSimilarity(allText(choices), allText(approved));
        return {
          score: similarity,
          checks: [
            {
              name: 'Close to the approved Choices',
              passed: similarity >= CLOSE_ENOUGH,
              detail: `${pct(similarity)} of words in common`,
            },
            {
              name: 'As many Choices as approved',
              passed: choices.length === approved.length,
              detail: `${choices.length} for ${approved.length}`,
            },
          ],
        };
      },
    };
  }

  /** A Spec Proposal after a Decision: the decided request, scored against the approved Spec. */
  private async specProposalCase(proposalId: string, model: ModelChoice | undefined) {
    const proposal = await this.db.specProposal.findUnique({
      where: { id: proposalId },
      include: {
        baseVersion: { select: { markdown: true } },
        resultVersion: { select: { markdown: true } },
        decision: { include: { choice: true, request: true } },
      },
    });
    const decided = proposal?.decision;
    if (!proposal || !decided) return null;
    const approved = proposal.resultVersion?.markdown ?? proposal.proposedMarkdown;
    const { request } = decided;
    const decision: DecisionForAi = decided.choice
      ? { kind: 'choice', choice: decided.choice, rationale: decided.rationale }
      : { kind: 'custom', answer: decided.customAnswer ?? '', rationale: decided.rationale };
    const raiserRole = await this.raiserRole(request);
    const specMarkdown = proposal.baseVersion?.markdown ?? '';
    return {
      name: `Spec Proposal: ${request.title}`,
      run: async (ai: AiPort, options: AiCallOptions) => {
        const { foundation, context } = await this.contextFor(
          'draftSpecProposal',
          request.featureId,
          `${request.title}\n\n${request.description}\n\n${describeDecision(decision)}`,
          request.id,
          model,
          estimateTokens(specMarkdown),
        );
        return ai.draftSpecProposal(
          {
            specMarkdown,
            context,
            foundation,
            // As drafted: the Platforms the base Spec has no section for (ticket 0051).
            missingSections: await this.coverage.missingSections(request.featureId, specMarkdown),
            request: {
              kind: request.kind,
              title: request.title,
              description: request.description,
              raiserRole,
            },
            decision,
          },
          options,
        );
      },
      score: (output: unknown) => {
        const similarity = lineSimilarity((output as SpecProposalDraft).proposedMarkdown, approved);
        return {
          score: similarity,
          checks: [
            {
              name: 'Close to the approved Spec',
              passed: similarity >= CLOSE_ENOUGH,
              detail: `${pct(similarity)} of lines the same`,
            },
          ],
        };
      },
    };
  }
}
