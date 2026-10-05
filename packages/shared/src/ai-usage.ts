import { z } from 'zod';
import { AiTask } from './ai-settings.ts';
import { ProposalKind } from './enums.ts';

// The AI usage dashboard (ticket 0075): what the AI costs, where, and what it buys, from
// the Receipts (ticket 0070). Admins only. Tokens are always shown; a cost only for calls
// on an Approved Model with a price, estimated in US dollars.

const Id = z.uuid();
const IsoDate = z.iso.date();
const Tokens = z.number().min(0);
const Usd = z.number().min(0);
const DAY = 24 * 60 * 60 * 1000;

/** The range a query covers when it leaves `from` out: the 30 days ending with `to`. */
export const AI_USAGE_DEFAULT_DAYS = 30;
/** The longest range one query may cover. */
export const AI_USAGE_MAX_DAYS = 366;
/** The shares of the monthly budget at which the Admins get a Notification. */
export const AI_BUDGET_THRESHOLDS = [80, 100] as const;

/**
 * `GET /settings/ai/usage?from&to`: days in the Organization's time zone (its Working
 * Time's), both included. `to` defaults to today, `from` to 29 days before `to`.
 */
export const AiUsageQuery = z
  .object({ from: IsoDate.optional(), to: IsoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine(
    (q) =>
      !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / DAY + 1 <= AI_USAGE_MAX_DAYS,
    { message: `The range can cover at most ${AI_USAGE_MAX_DAYS} days`, path: ['from'] },
  );
export type AiUsageQuery = z.infer<typeof AiUsageQuery>;

/** What a set of AI calls used: the totals and every breakdown share this shape. */
export const AiUsageTotals = z.object({
  /** Calls made, failed ones included. */
  calls: z.int().min(0),
  failedCalls: z.int().min(0),
  inputTokens: Tokens,
  outputTokens: Tokens,
  /** Input tokens read from the provider's prompt cache (a part of `inputTokens`). */
  cacheReadTokens: Tokens,
  cacheWriteTokens: Tokens,
  /** Cache reads over input tokens; null with no input tokens. */
  cacheHitRatio: z.number().min(0).nullable(),
  /**
   * Estimated, from the prices of the Approved Models the calls ran on; null when none
   * of them had a price. When only some did, it is theirs alone (see `unpricedCalls`).
   */
  costUsd: Usd.nullable(),
  /** Calls whose model had no price (or was not an Approved Model): not in `costUsd`. */
  unpricedCalls: z.int().min(0),
  /** Over the successful calls; null with none. */
  latencyP50Ms: z.number().min(0).nullable(),
  latencyP95Ms: z.number().min(0).nullable(),
});
export type AiUsageTotals = z.infer<typeof AiUsageTotals>;

/** A task an Admin sets a model for (AI models), or the Eval Runs, which are counted apart. */
export const AiUsageTask = z.enum([...AiTask.options, 'EVAL_RUN']);
export type AiUsageTask = z.infer<typeof AiUsageTask>;

export const AiUsageByTask = AiUsageTotals.extend({ task: AiUsageTask });
export type AiUsageByTask = z.infer<typeof AiUsageByTask>;

export const AiUsageByProject = AiUsageTotals.extend({
  /** Null: work for the whole Organization (Prompt proposals, Eval Runs). */
  projectId: Id.nullable(),
  /** Null when the Project was deleted since, or for the whole Organization. */
  projectName: z.string().nullable(),
});
export type AiUsageByProject = z.infer<typeof AiUsageByProject>;

export const AiUsageByModel = AiUsageTotals.extend({
  /** Null: a model set on the server (VORASAAN_MODEL_*), not an Approved Model. */
  approvedModelId: z.string().nullable(),
  /** The Approved Model's name, or the provider's model id when it is gone or not one. */
  name: z.string(),
  /** The provider's model id, as the last call recorded it. */
  modelName: z.string().nullable(),
  /** Whether it has a price now (its cost is estimated from that price). */
  priced: z.boolean(),
});
export type AiUsageByModel = z.infer<typeof AiUsageByModel>;

/** One day of the range, in the Organization's time zone; days without calls are zeros. */
export const AiUsageDay = z.object({
  date: IsoDate,
  calls: z.int().min(0),
  inputTokens: Tokens,
  outputTokens: Tokens,
  costUsd: Usd.nullable(),
});
export type AiUsageDay = z.infer<typeof AiUsageDay>;

/**
 * Cost per decision: what the AI spent on each Decision Request decided in the range, from
 * raise to Decision (its Choices and their Redrafts) plus its Spec Proposal and its Redrafts,
 * averaged over the decided requests that had any. Eval Runs never count.
 */
export const AiCostPerDecision = z.object({
  /** Decisions in the range whose request the AI worked on. */
  decisions: z.int().min(0),
  calls: z.int().min(0),
  /** Average input plus output tokens per decision; null with no decisions. */
  averageTokens: Tokens.nullable(),
  /** Average estimated cost per decision; null when no call had a price. */
  averageCostUsd: Usd.nullable(),
  unpricedCalls: z.int().min(0),
});
export type AiCostPerDecision = z.infer<typeof AiCostPerDecision>;

/** Redrafts before approval, per kind of proposal approved in the range. */
export const AiRedraftsBeforeApproval = z.object({
  proposalKind: ProposalKind,
  approvals: z.int().min(1),
  /** Approved as first drafted (no Redraft). */
  firstDraftApprovals: z.int().min(0),
  averageRedrafts: z.number().min(0),
});
export type AiRedraftsBeforeApproval = z.infer<typeof AiRedraftsBeforeApproval>;

/** The Organization's monthly budget and this month's estimated spend. */
export const AiBudgetView = z.object({
  /** US dollars a month; null: no budget. */
  monthlyUsd: Usd.nullable(),
  /** This month, "2026-10", in `timeZone`. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spentUsd: Usd,
  /** Spent over budget (1 = 100%); null with no budget. */
  share: z.number().min(0).nullable(),
});
export type AiBudgetView = z.infer<typeof AiBudgetView>;

/** `GET /settings/ai/usage`. */
export const AiUsageView = z.object({
  from: IsoDate,
  to: IsoDate,
  /** The Organization's time zone: days, months and the range are its. */
  timeZone: z.string(),
  totals: AiUsageTotals,
  byTask: z.array(AiUsageByTask),
  byProject: z.array(AiUsageByProject),
  byModel: z.array(AiUsageByModel),
  daily: z.array(AiUsageDay),
  costPerDecision: AiCostPerDecision,
  redraftsBeforeApproval: z.array(AiRedraftsBeforeApproval),
  budget: AiBudgetView,
  /** Whether any Approved Model has a price; without one no cost is shown. */
  anyPrices: z.boolean(),
});
export type AiUsageView = z.infer<typeof AiUsageView>;

/** `PUT /settings/ai/usage/budget`: US dollars a month, or null for none. */
export const AiBudgetInput = z.strictObject({
  monthlyUsd: z
    .number('Enter an amount')
    .positive('A budget must be more than 0')
    .max(10_000_000, 'At most $10,000,000')
    .nullable(),
});
export type AiBudgetInput = z.infer<typeof AiBudgetInput>;
