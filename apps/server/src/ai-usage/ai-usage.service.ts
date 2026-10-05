import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import {
  AI_BUDGET_THRESHOLDS,
  AI_USAGE_DEFAULT_DAYS,
  AI_USAGE_MAX_DAYS,
  type AiBudgetInput,
  type AiBudgetView,
  type AiCostPerDecision,
  type AiRedraftsBeforeApproval,
  AiTask,
  type AiUsageByModel,
  type AiUsageByProject,
  type AiUsageByTask,
  type AiUsageDay,
  type AiUsageQuery,
  type AiUsageTask,
  type AiUsageTotals,
  type AiUsageView,
  type ProposalKind,
} from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import type { ReceiptSettings } from '../receipts/receipts.service.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { localIsoDate, startOfLocalDate } from '../response-windows/working-time.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const TASK_ORDER: readonly AiUsageTask[] = [...AiTask.options, 'EVAL_RUN'];

/** The Organization the dashboard is about, with its budget and time zone. */
type Context = { organizationId: string; budget: number | null; timeZone: string };

/** One row of the grouped aggregate: which grouping it belongs to, and its sums. */
type AggregateRow = {
  dim: 'task' | 'project' | 'model' | 'day' | 'total';
  task: string | null;
  projectId: string | null;
  projectName: string | null;
  modelKey: string | null;
  approvedModelId: string | null;
  displayName: string | null;
  modelName: string | null;
  priced: boolean | null;
  day: string | null;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  unpricedCalls: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

/** `timestamp(3)` columns hold UTC: compare them with an instant written the same way. */
const utc = (t: Date) => t.toISOString();

/**
 * The AI usage dashboard and the monthly AI budget (ticket 0075), from the Receipts
 * (ticket 0070). Everything is aggregated in the database, a fixed few statements
 * whatever the range. Costs are estimates from the prices an Admin sets on each Approved
 * Model, applied to every Receipt of that model when read (a new price re-prices the past).
 */
@Injectable()
export class AiUsageService implements OnModuleInit {
  private readonly logger = new Logger('AiUsage');

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly receipts: ReceiptsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Each new Receipt may cross a threshold of the budget; without a budget nothing runs.
    this.receipts.onRecorded(async (_receipt, settings) => this.afterReceipt(settings));
  }

  // ─── The dashboard ─────────────────────────────────────────────────────────

  async view(query: AiUsageQuery): Promise<AiUsageView> {
    const context = await this.context();
    const { timeZone } = context;
    const today = localIsoDate(this.clock.now(), timeZone);
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -(AI_USAGE_DEFAULT_DAYS - 1));
    const days = daysBetween(from, to) + 1;
    // The query schema checks a range given in full; this also covers one side left out.
    if (days < 1 || days > AI_USAGE_MAX_DAYS) {
      throw new BadRequestException(
        `The range must not end before it starts and can cover at most ${AI_USAGE_MAX_DAYS} days`,
      );
    }
    const start = startOfLocalDate(from, timeZone);
    const end = startOfLocalDate(addDays(to, 1), timeZone);

    const [rows, costPerDecision, redrafts, budget] = await Promise.all([
      this.aggregate(start, end, timeZone),
      this.costPerDecision(start, end),
      this.redraftsBeforeApproval(start, end),
      this.budget(context),
    ]);

    const totals = rows.find((r) => r.dim === 'total');
    const byTask = rows
      .filter((r) => r.dim === 'task')
      .map((r): AiUsageByTask => ({ task: r.task as AiUsageTask, ...usage(r) }))
      .sort((a, b) => TASK_ORDER.indexOf(a.task) - TASK_ORDER.indexOf(b.task));
    const byProject = rows
      .filter((r) => r.dim === 'project')
      .map(
        (r): AiUsageByProject => ({
          projectId: r.projectId,
          projectName: r.projectName,
          ...usage(r),
        }),
      )
      .sort(byCostThenTokens);
    const byModel = rows
      .filter((r) => r.dim === 'model')
      .map(
        (r): AiUsageByModel => ({
          approvedModelId: r.approvedModelId,
          name: r.displayName ?? r.modelName ?? 'Unknown model',
          modelName: r.modelName,
          priced: Boolean(r.priced),
          ...usage(r),
        }),
      )
      .sort(byCostThenTokens);
    const perDay = new Map(rows.filter((r) => r.dim === 'day').map((r) => [r.day, r]));
    const daily = Array.from({ length: days }, (_, i): AiUsageDay => {
      const date = addDays(from, i);
      const row = perDay.get(date);
      return {
        date,
        calls: row?.calls ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        costUsd: row?.costUsd ?? null,
      };
    });

    return {
      from,
      to,
      timeZone,
      totals: totals ? usage(totals) : usage(null),
      byTask,
      byProject,
      byModel,
      daily,
      costPerDecision,
      redraftsBeforeApproval: redrafts,
      budget: budget.view,
      anyPrices: budget.anyPrices,
    };
  }

  /**
   * Every breakdown in one statement: the range's Receipts grouped by task (Eval Runs
   * apart), Project, model, day and all together, each with its tokens, estimated cost
   * and latency percentiles (nearest rank, over the successful calls).
   */
  private aggregate(start: Date, end: Date, timeZone: string): Promise<AggregateRow[]> {
    // Narrow rows to sort (names are joined once grouped); one sort for both percentiles.
    return this.db.$queryRaw<AggregateRow[]>`
      WITH r AS (
        SELECT
          CASE WHEN r."evalRunId" IS NOT NULL THEN 'EVAL_RUN' ELSE r."taskKind" END AS task,
          r."projectId",
          COALESCE(r."approvedModelId", 'env:' || COALESCE(r."modelName", '')) AS "modelKey",
          r."approvedModelId",
          r."modelName",
          timezone(${timeZone}, r."createdAt" AT TIME ZONE 'UTC')::date AS day,
          r."inputTokens", r."outputTokens", r."cacheReadTokens", r."cacheWriteTokens",
          CASE WHEN r.success THEN r."latencyMs" END AS latency,
          r.success,
          (COALESCE(r."inputTokens", 0) * m."inputPricePerMillion"
            + COALESCE(r."outputTokens", 0) * m."outputPricePerMillion") / 1000000.0 AS cost
        FROM "Receipt" r
        LEFT JOIN "ApprovedModel" m ON m.id = r."approvedModelId"
        WHERE r."createdAt" >= (${utc(start)}::timestamptz AT TIME ZONE 'UTC')
          AND r."createdAt" < (${utc(end)}::timestamptz AT TIME ZONE 'UTC')
      ),
      g AS (
        SELECT
          CASE
            WHEN GROUPING(task) = 0 THEN 'task'
            WHEN GROUPING("projectId") = 0 THEN 'project'
            WHEN GROUPING("modelKey") = 0 THEN 'model'
            WHEN GROUPING(day) = 0 THEN 'day'
            ELSE 'total'
          END AS dim,
          task, "projectId", "modelKey", max("approvedModelId") AS "approvedModelId",
          max("modelName") AS "modelName",
          to_char(day, 'YYYY-MM-DD') AS day,
          count(*)::int AS calls,
          (count(*) FILTER (WHERE NOT success))::int AS "failedCalls",
          COALESCE(sum("inputTokens"), 0)::float8 AS "inputTokens",
          COALESCE(sum("outputTokens"), 0)::float8 AS "outputTokens",
          COALESCE(sum("cacheReadTokens"), 0)::float8 AS "cacheReadTokens",
          COALESCE(sum("cacheWriteTokens"), 0)::float8 AS "cacheWriteTokens",
          sum(cost)::float8 AS "costUsd",
          (count(*) FILTER (WHERE cost IS NULL))::int AS "unpricedCalls",
          percentile_disc(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY latency) AS latency
        FROM r
        GROUP BY GROUPING SETS ((task), ("projectId"), ("modelKey"), (day), ())
      )
      SELECT g.dim, g.task, g."projectId", p.name AS "projectName", g."modelKey",
        g."approvedModelId", m."displayName", g."modelName",
        m."inputPricePerMillion" IS NOT NULL AS priced, g.day, g.calls, g."failedCalls",
        g."inputTokens", g."outputTokens", g."cacheReadTokens", g."cacheWriteTokens",
        g."costUsd", g."unpricedCalls",
        g.latency[1]::float8 AS "latencyP50Ms", g.latency[2]::float8 AS "latencyP95Ms"
      FROM g
      LEFT JOIN "Project" p ON p.id = g."projectId"
      LEFT JOIN "ApprovedModel" m ON m.id = g."approvedModelId"`;
  }

  /**
   * What the AI spent on each Decision Request decided in the range: the Receipts of its
   * Choices (Redraft 1 and later), and of its Spec Proposal and that proposal's Redrafts.
   * Eval Runs are left out. Averaged over the decided requests with any such Receipt.
   */
  private async costPerDecision(start: Date, end: Date): Promise<AiCostPerDecision> {
    const [row] = await this.db.$queryRaw<
      {
        decisions: number;
        calls: number;
        averageTokens: number | null;
        averageCostUsd: number | null;
        unpricedCalls: number;
      }[]
    >`
      WITH d AS (
        SELECT id, "requestId" FROM "Decision"
        WHERE "createdAt" >= (${utc(start)}::timestamptz AT TIME ZONE 'UTC')
          AND "createdAt" < (${utc(end)}::timestamptz AT TIME ZONE 'UTC')
      ),
      linked AS (
        SELECT d."requestId", r."inputTokens", r."outputTokens", r."approvedModelId"
        FROM d JOIN "Receipt" r
          ON r."proposalKind" = 'CHOICES' AND r."proposalId" = d."requestId"
        WHERE r."evalRunId" IS NULL
        UNION ALL
        SELECT d."requestId", r."inputTokens", r."outputTokens", r."approvedModelId"
        FROM d
        JOIN "SpecProposal" sp ON sp."decisionId" = d.id
        JOIN "Receipt" r ON r."proposalKind" = 'SPEC_PROPOSAL' AND r."proposalId" = sp.id
        WHERE r."evalRunId" IS NULL
      ),
      per AS (
        SELECT
          l."requestId",
          count(*) AS calls,
          sum(COALESCE(l."inputTokens", 0) + COALESCE(l."outputTokens", 0)) AS tokens,
          sum(CASE WHEN m."inputPricePerMillion" IS NULL THEN NULL
                   ELSE (COALESCE(l."inputTokens", 0) * m."inputPricePerMillion"
                       + COALESCE(l."outputTokens", 0) * m."outputPricePerMillion") / 1000000.0
              END) AS cost,
          count(*) FILTER (WHERE m."inputPricePerMillion" IS NULL) AS unpriced
        FROM linked l LEFT JOIN "ApprovedModel" m ON m.id = l."approvedModelId"
        GROUP BY l."requestId"
      )
      SELECT
        count(*)::int AS decisions,
        COALESCE(sum(calls), 0)::int AS calls,
        avg(tokens)::float8 AS "averageTokens",
        avg(cost)::float8 AS "averageCostUsd",
        COALESCE(sum(unpriced), 0)::int AS "unpricedCalls"
      FROM per`;
    return {
      decisions: row?.decisions ?? 0,
      calls: row?.calls ?? 0,
      averageTokens: row?.averageTokens ?? null,
      averageCostUsd: row?.averageCostUsd ?? null,
      unpricedCalls: row?.unpricedCalls ?? 0,
    };
  }

  /** Redrafts before approval, per kind of proposal, from the approvals in the range. */
  private async redraftsBeforeApproval(
    start: Date,
    end: Date,
  ): Promise<AiRedraftsBeforeApproval[]> {
    const rows = await this.db.$queryRaw<
      {
        proposalKind: ProposalKind;
        approvals: number;
        firstDraftApprovals: number;
        averageRedrafts: number;
      }[]
    >`
      SELECT
        "proposalKind"::text AS "proposalKind",
        count(*)::int AS approvals,
        (count(*) FILTER (WHERE COALESCE("redraftsBeforeApproval", 0) = 0))::int
          AS "firstDraftApprovals",
        avg(COALESCE("redraftsBeforeApproval", 0))::float8 AS "averageRedrafts"
      FROM "ReceiptOutcome"
      WHERE kind = 'APPROVE'
        AND "createdAt" >= (${utc(start)}::timestamptz AT TIME ZONE 'UTC')
        AND "createdAt" < (${utc(end)}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY "proposalKind"
      ORDER BY "proposalKind"`;
    return rows;
  }

  // ─── The budget ────────────────────────────────────────────────────────────

  /** The Organization's id, budget and time zone (its Working Time's, else UTC). */
  private async context(): Promise<Context> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, aiMonthlyBudget: true, responseWindow: { select: { timeZone: true } } },
    });
    if (!org) throw new UnprocessableEntityException('Run setup first');
    return {
      organizationId: org.id,
      budget: org.aiMonthlyBudget,
      timeZone: org.responseWindow?.timeZone ?? 'UTC',
    };
  }

  /** This month in the Organization's time zone: its name and where it starts and ends. */
  private month(timeZone: string): { month: string; start: Date; end: Date } {
    const today = localIsoDate(this.clock.now(), timeZone);
    const [y = 1970, m = 1] = today.split('-').map(Number);
    const first = `${today.slice(0, 7)}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return {
      month: today.slice(0, 7),
      start: startOfLocalDate(first, timeZone),
      end: startOfLocalDate(next, timeZone),
    };
  }

  /** This month's estimated spend (Eval Runs included: they cost the same), and the budget. */
  private async budget(
    context: Context,
  ): Promise<{ view: AiBudgetView; anyPrices: boolean; month: string }> {
    const { month, start, end } = this.month(context.timeZone);
    const [row] = await this.db.$queryRaw<{ spent: number; anyPrices: boolean }[]>`
      SELECT
        COALESCE(sum((COALESCE(r."inputTokens", 0) * m."inputPricePerMillion"
                    + COALESCE(r."outputTokens", 0) * m."outputPricePerMillion") / 1000000.0),
                 0)::float8 AS spent,
        EXISTS (SELECT 1 FROM "ApprovedModel" WHERE "inputPricePerMillion" IS NOT NULL)
          AS "anyPrices"
      FROM "Receipt" r
      JOIN "ApprovedModel" m ON m.id = r."approvedModelId" AND m."inputPricePerMillion" IS NOT NULL
      WHERE r."createdAt" >= (${utc(start)}::timestamptz AT TIME ZONE 'UTC')
        AND r."createdAt" < (${utc(end)}::timestamptz AT TIME ZONE 'UTC')`;
    const spentUsd = row?.spent ?? 0;
    return {
      month,
      anyPrices: Boolean(row?.anyPrices),
      view: {
        monthlyUsd: context.budget,
        month,
        spentUsd,
        share: context.budget ? spentUsd / context.budget : null,
      },
    };
  }

  /** `PUT /settings/ai/usage/budget`: sets or clears it, and checks it against this month. */
  async setBudget(input: AiBudgetInput): Promise<AiBudgetView> {
    const { organizationId } = await this.context();
    await this.db.$transaction([
      this.db.organization.update({
        where: { id: organizationId },
        data: { aiMonthlyBudget: input.monthlyUsd },
      }),
      // A new budget is checked afresh: this month's thresholds may be crossed again.
      this.db.aiBudgetAlert.deleteMany({ where: { organizationId } }),
    ]);
    const context = await this.context();
    await this.check(context);
    return (await this.budget(context)).view;
  }

  /** After each Receipt (in its background write): only with a budget. */
  private async afterReceipt(settings: ReceiptSettings): Promise<void> {
    if (settings.aiMonthlyBudget === null || !settings.organizationId) return;
    await this.check(await this.context());
  }

  /**
   * Notifies the Admins once per threshold per month (80% and 100%) when this month's
   * estimated spend has crossed it. The alert's key keeps it to one, however many Receipts
   * cross it at once; a jump past both sends only the 100% Notification. Nothing is blocked.
   */
  private async check(context: Context): Promise<void> {
    if (context.budget === null) return;
    const { view, month } = await this.budget(context);
    const crossed = AI_BUDGET_THRESHOLDS.filter(
      (t) => view.spentUsd >= (context.budget ?? 0) * (t / 100),
    );
    if (!crossed.length) return;
    const outbox = this.notifications.outbox();
    await this.db.$transaction(async (tx) => {
      const added = await tx.aiBudgetAlert.createManyAndReturn({
        data: crossed.map((threshold) => ({
          organizationId: context.organizationId,
          month,
          threshold,
          createdAt: this.clock.now(),
        })),
        skipDuplicates: true,
        select: { threshold: true },
      });
      const highest = Math.max(0, ...added.map((a) => a.threshold));
      if (!highest) return;
      const admins = await tx.orgMembership.findMany({
        where: { organizationId: context.organizationId, role: 'ADMIN' },
        select: { userId: true },
      });
      await this.notifications.notify(tx, outbox, {
        type: highest >= 100 ? 'AI_BUDGET_REACHED' : 'AI_BUDGET_WARNING',
        to: admins.map((a) => a.userId),
        actorId: null,
      });
    });
    await this.notifications.publish(outbox);
    if (outbox.notifications.length) {
      this.logger.log(`AI budget: ${Math.round((view.share ?? 0) * 100)}% of ${month} spent`);
    }
  }
}

/** A row's sums as the contract shapes them; null: no calls. */
function usage(row: AggregateRow | null): AiUsageTotals {
  const input = row?.inputTokens ?? 0;
  return {
    calls: row?.calls ?? 0,
    failedCalls: row?.failedCalls ?? 0,
    inputTokens: input,
    outputTokens: row?.outputTokens ?? 0,
    cacheReadTokens: row?.cacheReadTokens ?? 0,
    cacheWriteTokens: row?.cacheWriteTokens ?? 0,
    cacheHitRatio: input > 0 ? (row?.cacheReadTokens ?? 0) / input : null,
    costUsd: row?.costUsd ?? null,
    unpricedCalls: row?.unpricedCalls ?? 0,
    latencyP50Ms: row?.latencyP50Ms ?? null,
    latencyP95Ms: row?.latencyP95Ms ?? null,
  };
}

function byCostThenTokens(a: AiUsageTotals, b: AiUsageTotals): number {
  return (
    (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  );
}

/** The date `n` days after `date` ("2026-10-05"); calendar arithmetic, no time zone. */
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
