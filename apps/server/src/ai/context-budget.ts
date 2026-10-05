import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import type { AiTask } from './ai.config.ts';
import type { ChatTool, ModelChoice } from './ai.port.ts';
import { AiSettingsService } from './ai-settings.service.ts';
import { skillTokens, TASK_SKILLS } from './prompts.ts';

/**
 * Each AI workflow that gets retrieved context (ADR 0007), and the most retrieved
 * context it takes however large the window is. Past these, a larger window buys
 * nothing: a longer prompt costs more, is slower and is answered less accurately
 * (ADR 0012, "Rejected"). They are twice the fixed budgets used before ticket 0060.
 */
export const CONTEXT_CEILINGS = {
  /** Choice generation and Spec Proposal drafting: the Spec plus the most relevant context. */
  decisionRequest: 12_000,
  /** Drafting a Spec from Attachments: they are the main input. */
  specFromAttachments: 30_000,
  /** Grilling questions and the Brief drafted from them: the whole Project is the input. */
  grilling: 24_000,
  /** Feature Suggestions and the first Spec of an accepted one. */
  featureSuggestions: 24_000,
  /** The Feature Guidelines fit check of a Feature about to be created. */
  featureFit: 12_000,
  /** Each turn of a Feature Conversation. */
  conversationFeature: 12_000,
  /** Each turn of a Project Conversation. */
  conversationProject: 24_000,
} as const;
export type Workflow = keyof typeof CONTEXT_CEILINGS;

/**
 * How many chunks each search of a workflow's retrieval returns (ticket 0076); none
 * fills the budget. Until then every search returned enough chunks to fill the context
 * ceiling (its budget over 400-token chunks: 30 for a Decision Request, about 70 for a
 * Project-level task), and since the ceilings doubled (0060) the second half was mostly
 * chunks ranked far down. These are the sizes before 0060: the top chunks of each search,
 * with the Feature's own Spec, requests and Decisions (or the Brief and the Feature
 * overview) still first and whole. The ceiling stays the limit. Drafting a Spec from
 * Attachments keeps filling its budget: the Attachments are its input.
 */
export const RETRIEVAL_TOP_K: Record<Workflow, number | undefined> = {
  decisionRequest: 15,
  specFromAttachments: undefined,
  grilling: 30,
  featureSuggestions: 30,
  featureFit: 15,
  conversationFeature: 15,
  conversationProject: 30,
};

/**
 * The one config of every budget (ADR 0012, ticket 0060). A call's window is
 * split into four shares; each has a floor, so a small model still gets
 * something useful, and a ceiling, so a large one isn't filled for its own sake.
 */
export const BUDGET_CONFIG = {
  shares: {
    /** The system prompt (instructions, tools) and the foundation (Brief, Guidelines). */
    foundation: 0.15,
    /** Retrieved context (ADR 0007), in its usual order. */
    context: 0.4,
    /** A Conversation's history: its Conversation Summary and its newest messages. */
    history: 0.25,
    /** Room for the reply (and, in a Conversation, the turn's tool rounds). */
    reply: 0.2,
  },
  floors: {
    /** The Brief and the Guidelines, after the system prompt took what it needs. */
    foundation: 300,
    context: 1_000,
    history: 1_000,
    reply: 1_000,
  },
  ceilings: {
    /** The Brief and the Guidelines. */
    foundation: 4_000,
    history: 32_000,
    reply: 16_000,
  },
  /** Auto-compaction of a Conversation's history (it replaces the 12-message rule of 0042). */
  compaction: {
    /** Compact once the history passes this part of its share. */
    at: 0.7,
    /** Keep the newest turns word for word, up to this part of the share. */
    keep: 0.35,
    /** The Conversation Summary is cut to this part of the share. */
    summary: 0.25,
    /** The context meter (ticket 0066) warns from this part of the share: compaction is near. */
    warn: 0.6,
  },
  /**
   * What filling a prompt in adds besides its data and its template: names,
   * versions, block tags, separators. Counted in the fixed part of every call.
   */
  promptSlack: 150,
  /** One `searchContext` tool call in a Conversation (Action Cards, 0043): a focused extra read. */
  searchContext: { share: 0.05, floor: 500, ceiling: 6_000 },
} as const;

/** How one call's window is spent, in tokens. They add up to at most `window` when it can. */
export type Budget = {
  window: number;
  /** The fixed part: the prompt's instructions and tools, and inputs sent whole (a Spec being edited). */
  system: number;
  /** The Brief and the Guidelines. */
  foundation: number;
  /** Retrieved context. */
  context: number;
  /** A Conversation's summary and messages; 0 for a one-shot task. */
  history: number;
  reply: number;
  /** How many chunks each search returns (`RETRIEVAL_TOP_K`); none fills `context`. */
  topK?: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Splits a model's window for one call of `workflow`. `system` is what the
 * prompt costs whatever the content (instructions, tools, inputs sent whole); it
 * comes out of the foundation's share first, then out of the context's. A
 * one-shot task has no history, so its context also gets the history's share.
 * Past the window, the context gives way first, down to its floor, then the
 * history, then the foundation, then the context and the history entirely.
 */
export function planBudget(
  window: number,
  workflow: Workflow,
  options: { system?: number; conversation?: boolean } = {},
): Budget {
  const { shares, floors, ceilings } = BUDGET_CONFIG;
  const w = Math.max(0, Math.floor(window));
  const system = Math.max(0, Math.ceil(options.system ?? 0));
  const conversation = options.conversation ?? workflow.startsWith('conversation');

  const reply = clamp(w * shares.reply, floors.reply, ceilings.reply);
  const foundationShare = Math.max(floors.foundation, Math.floor(w * shares.foundation));
  let foundation = clamp(foundationShare - system, floors.foundation, ceilings.foundation);
  let history = conversation ? clamp(w * shares.history, floors.history, ceilings.history) : 0;
  const contextShare = w * (shares.context + (conversation ? 0 : shares.history));
  const overflow = Math.max(0, system - foundationShare);
  let context = clamp(contextShare - overflow, floors.context, CONTEXT_CEILINGS[workflow]);

  let excess = system + foundation + context + history + reply - w;
  const give = (amount: number, floor: number): number => {
    const taken = Math.max(0, Math.min(excess, amount - floor));
    excess -= taken;
    return amount - taken;
  };
  context = give(context, floors.context);
  history = give(history, floors.history);
  foundation = give(foundation, 0);
  context = give(context, 0);
  history = give(history, 0);
  return {
    window: w,
    system,
    foundation,
    context,
    history,
    reply,
    topK: RETRIEVAL_TOP_K[workflow],
  };
}

/**
 * A Project-level task's retrieval budget: its context share plus the
 * foundation's, since there the Brief is the first block of the retrieved
 * context (`ContextRetriever.forProject`), not a separate part of the prompt.
 */
export function projectBudget(budget: Budget): number {
  return budget.context + budget.foundation;
}

/** What a `searchContext` tool call may read, for a model with this window. */
export function searchContextBudget(window: number): number {
  const { share, floor, ceiling } = BUDGET_CONFIG.searchContext;
  return clamp(window * share, floor, ceiling);
}

/** What the tools offered to the AI cost in its prompt: names, descriptions and schemas. */
export function toolTokens(tools: ChatTool[]): number {
  return tools.reduce((sum, t) => {
    let schema = '';
    try {
      schema = JSON.stringify(z.toJSONSchema(t.inputSchema));
    } catch {
      schema = '{}';
    }
    return sum + estimateTokens(`${t.name}\n${t.description}\n${schema}`) + 10;
  }, 0);
}

/**
 * Budgets from the model a call will run on. A workflow chooses the model first
 * (as a Conversation turn does), plans its budgets from that model's window, and
 * then passes the same model to the AI call, so the call runs on the model it
 * was planned for.
 */
@Injectable()
export class ContextBudgets {
  constructor(private readonly models: AiSettingsService) {}

  async forTask(
    task: AiTask,
    workflow: Workflow,
    options: {
      /** The model already chosen (a Conversation's turn, a drafting Action Card). */
      model?: ModelChoice;
      approvedModelId?: string;
      /** Inputs sent whole besides the instructions, e.g. the Spec a draft edits. */
      fixed?: number;
      tools?: ChatTool[];
    } = {},
  ): Promise<{ model: ModelChoice; budget: Budget }> {
    const model = options.model ?? (await this.models.chooseModel(task, options.approvedModelId));
    const skill = TASK_SKILLS[task];
    const system =
      BUDGET_CONFIG.promptSlack +
      (skill ? await skillTokens(skill) : 0) +
      (options.fixed ?? 0) +
      toolTokens(options.tools ?? []);
    return { model, budget: planBudget(model.contextWindow, workflow, { system }) };
  }
}
