import { Controller, Get, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import {
  type AiTask as AiTaskKind,
  type ApprovedModelSettingsView,
  MODEL_SUGGESTION_DAYS,
  type ModelSuggestion,
  type ModelSuggestionPrompt,
  type ModelSuggestionsView,
  type UncheckedModel,
} from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import { AI_TASKS } from '../ai/ai.config.ts';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { AdminOnly } from '../auth/admin.guard.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { casesForPrompt } from '../evals/eval-sets.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { PromptVersionsService } from './prompt-versions.service.ts';
import { REPLAYABLE } from './replay.ts';

// Cheaper models for simple tasks (ticket 0076). For each Settings task, an Approved Model
// priced lower than the one the task runs on is suggested when, on every prompt of the
// task that can be evaluated, the latest Eval Run of the prompt's active version on it
// scores at least as well as the latest one on the current model, with the same sources.
// Nothing is switched: the Admin decides, with Settings → AI models (or the button that
// sets it). A cheaper model without such runs yet is listed with the prompts to evaluate.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The prompts of each Settings task (its AI tasks' prompts), in the order of `TASK_SKILLS`. */
export function promptsOfTask(kind: AiTaskKind): SkillName[] {
  const names = (Object.keys(TASK_SKILLS) as (keyof typeof TASK_SKILLS)[])
    .filter((task) => AI_TASKS[task].kind === kind)
    .map((task) => TASK_SKILLS[task]);
  return [...new Set(names)];
}

/** Whether a prompt can be evaluated at all: checked-in cases, or a replay. */
function evaluable(name: SkillName): boolean {
  return casesForPrompt(name).length > 0 || REPLAYABLE[name] !== undefined;
}

type Run = {
  id: string;
  promptName: string;
  promptVersion: string;
  approvedModelId: string | null;
  sources: string[];
  score: number | null;
};

/**
 * The two runs a prompt is compared by on two models: the latest done runs of `version`
 * on each, with the same sources (both sources first, when both models have such runs).
 */
export function comparableRuns(
  runs: Run[],
  prompt: string,
  version: string,
  current: string,
  suggested: string,
): { current: Run; suggested: Run } | null {
  const of = (modelId: string) =>
    runs.filter(
      (r) =>
        r.promptName === prompt &&
        r.promptVersion === version &&
        r.approvedModelId === modelId &&
        r.score !== null,
    );
  const key = (r: Run) => [...r.sources].sort().join('+');
  const mine = of(current);
  const theirs = of(suggested);
  const keys = [...new Set(mine.map(key))]
    .filter((k) => theirs.some((r) => key(r) === k))
    .sort((a, b) => b.split('+').length - a.split('+').length);
  const best = keys[0];
  if (best === undefined) return null;
  // `runs` is newest first: the first of each is the latest.
  const a = mine.find((r) => key(r) === best);
  const b = theirs.find((r) => key(r) === best);
  return a && b ? { current: a, suggested: b } : null;
}

/** What `input` and `output` tokens cost on a model, in US dollars; null without a price. */
function costOn(model: ApprovedModelSettingsView, input: number, output: number): number | null {
  if (!model.prices) return null;
  return (
    (input * model.prices.inputPerMillion + output * model.prices.outputPerMillion) / 1_000_000
  );
}

@Injectable()
export class ModelSuggestionsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly settings: AiSettingsService,
    private readonly prompts: PromptVersionsService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async view(): Promise<ModelSuggestionsView> {
    const organizationId = await this.prompts.organizationId();
    if (!organizationId) return { suggestions: [], unchecked: [] };
    const since = new Date(this.clock.now().getTime() - MODEL_SUGGESTION_DAYS * DAY_MS);
    const [settings, active, runs, usage] = await Promise.all([
      this.settings.view(),
      this.prompts.activeByPrompt(),
      this.db.promptEvalRun.findMany({
        where: { organizationId, status: 'DONE', score: { not: null } },
        orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          promptName: true,
          promptVersion: true,
          approvedModelId: true,
          sources: true,
          score: true,
        },
      }),
      this.db.receipt.groupBy({
        by: ['taskKind', 'approvedModelId'],
        // One Organization per instance: Receipts carry none.
        where: { evalRunId: null, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);
    const versionOf = async (name: SkillName) =>
      active.get(name)?.version ?? (await this.prompts.active(name)).version;
    const defaultModel = settings.models.find((m) => m.isDefault);
    const suggestions: ModelSuggestion[] = [];
    const unchecked: UncheckedModel[] = [];

    for (const task of settings.tasks) {
      // A model set on the server for this task wins over Settings: nothing to suggest.
      if (task.envOverrides.length) continue;
      const current = settings.models.find((m) => m.id === task.approvedModelId) ?? defaultModel;
      if (!current?.prices) continue;
      const prompts = promptsOfTask(task.task).filter(evaluable);
      if (!prompts.length) continue;
      const used = usage.find((u) => u.taskKind === task.task && u.approvedModelId === current.id);
      const input = used?._sum.inputTokens ?? 0;
      const output = used?._sum.outputTokens ?? 0;
      // Without calls yet, compare prices on a typical mix: three tokens in for one out.
      const mix = input + output > 0 ? { input, output } : { input: 3_000_000, output: 1_000_000 };
      const currentMixCost = costOn(current, mix.input, mix.output) ?? 0;
      const cheaper = settings.models
        .filter((m) => m.id !== current.id && m.prices)
        .map((m) => ({ model: m, cost: costOn(m, mix.input, mix.output) ?? 0 }))
        .filter((c) => c.cost < currentMixCost)
        .sort((a, b) => a.cost - b.cost);

      for (const { model } of cheaper) {
        const compared: ModelSuggestionPrompt[] = [];
        const missing: string[] = [];
        let holds = true;
        for (const prompt of prompts) {
          const version = await versionOf(prompt);
          const pair = comparableRuns(runs, prompt, version, current.id, model.id);
          if (!pair) {
            missing.push(prompt);
            continue;
          }
          const currentScore = pair.current.score ?? 0;
          const suggestedScore = pair.suggested.score ?? 0;
          if (suggestedScore < currentScore) holds = false;
          compared.push({
            prompt,
            version,
            current: { runId: pair.current.id, score: currentScore },
            suggested: { runId: pair.suggested.id, score: suggestedScore },
          });
        }
        if (!holds) continue;
        const ref = (m: ApprovedModelSettingsView) => ({
          approvedModelId: m.id,
          name: m.displayName,
        });
        if (missing.length) {
          unchecked.push({
            task: task.task,
            current: ref(current),
            suggested: ref(model),
            prompts: missing,
          });
          continue;
        }
        suggestions.push({
          task: task.task,
          current: ref(current),
          suggested: ref(model),
          prompts: compared,
          calls: used?._count._all ?? 0,
          currentCostUsd: costOn(current, input, output) ?? 0,
          suggestedCostUsd: costOn(model, input, output) ?? 0,
        });
        // The cheapest model that holds is the suggestion; dearer ones add nothing.
        break;
      }
    }
    return { suggestions, unchecked };
  }
}

/** Settings → AI usage, "Cheaper models" (ticket 0076). Admins only. */
@AdminOnly()
@Controller('settings/ai/model-suggestions')
export class ModelSuggestionsController {
  constructor(private readonly suggestions: ModelSuggestionsService) {}

  @Get()
  view(): Promise<ModelSuggestionsView> {
    return this.suggestions.view();
  }
}
