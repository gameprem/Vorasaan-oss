import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type {
  ActionCardKind,
  Prisma,
  PrismaClient,
  ProposalKind,
  ReceiptOutcomeKind,
} from '@vorasaan/db';
import {
  DEFAULT_RECEIPT_RETENTION_DAYS,
  diffLines,
  RECEIPT_EXPORT_FORMAT,
  type ReceiptExportLine,
  type ReceiptExportOutcome,
  type ReceiptSettingsInput,
  type ReceiptSettingsView,
} from '@vorasaan/shared';
import { skillVersion } from '@vorasaan/skills';
import { AI_TASKS, type AiTask } from '../ai/ai.config.ts';
import type { CallUsage, ModelChoice, PromptChoice, ReceiptLink } from '../ai/ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { PeopleRedactor } from './redact.ts';

/** One AI call, as `ReceiptingAiPort` saw it. */
export type ReceiptEntry = {
  task: AiTask;
  /** When the call started, on the app's clock (retention counts from it). */
  at: Date;
  latencyMs: number;
  success: boolean;
  /** Already redacted and short. */
  error: string | null;
  usage: CallUsage | null;
  model: ModelChoice | undefined;
  /** The version of the prompt it rendered (ticket 0071); left out, the built-in default. */
  prompt: PromptChoice | undefined;
  language: string | undefined;
  link: ReceiptLink | undefined;
};

/** The Organization's Receipt settings, and its AI budget (ticket 0075). */
export type ReceiptSettings = {
  enabled: boolean;
  retentionDays: number;
  /** Null before setup. */
  organizationId: string | null;
  /** US dollars a month; null: none. */
  aiMonthlyBudget: number | null;
};

/** Told each Receipt saved, with the settings it was saved under. */
export type RecordedListener = (
  receipt: Prisma.ReceiptUncheckedCreateInput,
  settings: ReceiptSettings,
) => Promise<void>;

/** A human outcome of a proposal (ticket 0070). */
export type OutcomeEntry = {
  kind: ReceiptOutcomeKind;
  proposal: { kind: ProposalKind; id: string };
  actorId: string | null;
  /** The Redraft it was given on; left out, the one the proposal holds now. */
  redraft?: number;
  /** DECLINE: the reason; REQUEST_CHANGES: the feedback. */
  reason?: string | null;
  choiceLabel?: string | null;
  editSize?: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Receipts read per query while exporting. */
const EXPORT_PAGE = 200;

/**
 * The Action Card kind whose target is this proposal (a Decision Request for its Choices).
 * A Prompt Version (ticket 0072) is never drafted in a Conversation.
 */
const CARD_KIND: Partial<Record<ProposalKind, ActionCardKind>> = {
  CHOICES: 'DECISION_REQUEST',
  SPEC_PROPOSAL: 'SPEC_PROPOSAL',
  BRIEF_PROPOSAL: 'BRIEF_PROPOSAL',
  FEATURE_SUGGESTION: 'FEATURE_SUGGESTION',
};

/** The provider kind of an env model, by its Mastra "provider/" prefix. */
const ENV_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  openrouter: 'OPENROUTER',
  google: 'GEMINI',
};

type ExportRow = Prisma.ReceiptGetPayload<{
  include: { outcomes: true; redraftOutcomes: true; agentSkills: true };
}>;

/**
 * Receipts (ADR 0015, ticket 0070): one per AI call, and the human outcomes of the
 * proposals they drafted. Everything here runs off the request path: `record` and
 * `outcome` return at once, write in the background, and a failure is logged and
 * dropped, so a Receipt never fails or slows the action that made it.
 *
 * Collection follows the Organization's setting: off, neither Receipts nor outcomes
 * are written. A daily job deletes both past the retention (`purge`).
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger('Receipts');
  /** Receipt writes in flight; outcomes wait for them, so they find their Receipt. */
  private readonly receiptWrites = new Set<Promise<unknown>>();
  private readonly outcomeWrites = new Set<Promise<unknown>>();
  /** Told the prompts of the Receipts each new outcome is linked to (ticket 0072). */
  private readonly outcomeListeners = new Set<(promptNames: string[]) => void>();
  /** Told each new Receipt once saved (ticket 0075: the AI budget). */
  private readonly recordedListeners = new Set<RecordedListener>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
  ) {}

  // ─── Writing ──────────────────────────────────────────────────────────────

  /** Saves one AI call's Receipt in the background. Never throws. */
  record(entry: ReceiptEntry): void {
    this.track(this.receiptWrites, async () => {
      const settings = await this.settings();
      if (!settings.enabled) return;
      const data = await receiptData(entry);
      data.projectId = await this.projectOf(entry.link);
      await this.persist(data);
      for (const listener of this.recordedListeners) {
        try {
          await listener(data, settings);
        } catch (error) {
          this.logger.warn(`A Receipt listener failed: ${(error as Error)?.message ?? error}`);
        }
      }
    });
  }

  /**
   * Calls `listener` once each new Receipt is saved, with the Organization's Receipt settings
   * (the AI budget among them), inside the write: `drain()` waits for it too (ticket 0075).
   */
  onRecorded(listener: RecordedListener): () => void {
    this.recordedListeners.add(listener);
    return () => this.recordedListeners.delete(listener);
  }

  /** The Project of the call: given, or its Feature's (looked up here, off the request path). */
  private async projectOf(link: ReceiptLink | undefined): Promise<string | null> {
    if (link?.projectId) return link.projectId;
    if (!link?.featureId) return null;
    const feature = await this.db.feature.findUnique({
      where: { id: link.featureId },
      select: { team: { select: { projectId: true } } },
    });
    return feature?.team.projectId ?? null;
  }

  /** Links a human outcome to the Receipt that drafted the proposal, in the background. */
  outcome(entry: OutcomeEntry): void {
    this.track(this.outcomeWrites, async () => {
      // A Receipt still being saved is found once it is.
      await Promise.allSettled([...this.receiptWrites]);
      if (!(await this.settings()).enabled) return;
      const data = await this.outcomeData(entry);
      if (!data) return;
      await this.db.receiptOutcome.create({ data });
      if (this.outcomeListeners.size) await this.announceOutcome(data);
    });
  }

  /**
   * Calls `listener` with the prompts a new outcome's Receipts rendered (the one that drafted
   * the proposal, and the one that wrote its Redraft), once it is saved. Returns the unsubscribe.
   */
  onOutcome(listener: (promptNames: string[]) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  private async announceOutcome(data: { receiptId: string; redraftReceiptId?: string | null }) {
    const ids = [data.receiptId, data.redraftReceiptId].filter((id): id is string => Boolean(id));
    const rows = await this.db.receipt.findMany({
      where: { id: { in: ids }, evalRunId: null },
      select: { promptName: true },
    });
    const names = [...new Set(rows.map((r) => r.promptName))];
    if (!names.length) return;
    for (const listener of this.outcomeListeners) {
      try {
        listener(names);
      } catch (error) {
        this.logger.warn(`An outcome listener failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  /**
   * A Spec or Brief Version written by hand (`versionId`) right after the one an approved
   * proposal made (the window is one version): a MANUAL_EDIT of that proposal, sized in
   * lines added plus lines removed. Looked up in the background, like everything here.
   */
  editedByHand(kind: 'SPEC_PROPOSAL' | 'BRIEF_PROPOSAL', versionId: string, actorId: string): void {
    this.track(this.outcomeWrites, async () => {
      const pair = await this.versionPair(kind, versionId);
      if (!pair?.previous.proposalId) return;
      const editSize = diffLines(pair.previous.markdown, pair.markdown).filter(
        (l) => l.kind !== 'UNCHANGED',
      ).length;
      if (!editSize) return;
      this.outcome({
        kind: 'MANUAL_EDIT',
        proposal: { kind, id: pair.previous.proposalId },
        actorId,
        editSize,
      });
    });
  }

  /** A version's Markdown and the version just before it. */
  private async versionPair(
    kind: 'SPEC_PROPOSAL' | 'BRIEF_PROPOSAL',
    versionId: string,
  ): Promise<{
    markdown: string;
    previous: { proposalId: string | null; markdown: string };
  } | null> {
    const select = { proposalId: true, markdown: true } as const;
    if (kind === 'SPEC_PROPOSAL') {
      const v = await this.db.specVersion.findUnique({ where: { id: versionId } });
      if (!v || v.version < 2) return null;
      const previous = await this.db.specVersion.findUnique({
        where: { featureId_version: { featureId: v.featureId, version: v.version - 1 } },
        select,
      });
      return previous ? { markdown: v.markdown, previous } : null;
    }
    const v = await this.db.briefVersion.findUnique({ where: { id: versionId } });
    if (!v || v.version < 2) return null;
    const previous = await this.db.briefVersion.findUnique({
      where: { projectId_version: { projectId: v.projectId, version: v.version - 1 } },
      select,
    });
    return previous ? { markdown: v.markdown, previous } : null;
  }

  /** The database write of a Receipt (a seam tests use to make writing fail or hang). */
  protected persist(data: Prisma.ReceiptUncheckedCreateInput): Promise<unknown> {
    return this.db.receipt.create({ data, select: { id: true } });
  }

  /** Waits for every write in flight (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.receiptWrites.size || this.outcomeWrites.size) {
      await Promise.allSettled([...this.receiptWrites, ...this.outcomeWrites]);
    }
  }

  private track(set: Set<Promise<unknown>>, work: () => Promise<void>) {
    const running = Promise.resolve()
      .then(work)
      .catch((error) =>
        this.logger.warn(`Could not save a Receipt: ${(error as Error)?.message ?? error}`),
      );
    set.add(running);
    void running.finally(() => set.delete(running));
  }

  /** The outcome row, or null when no Receipt drafted the proposal (collection was off then). */
  private async outcomeData(
    entry: OutcomeEntry,
  ): Promise<Prisma.ReceiptOutcomeUncheckedCreateInput | null> {
    const { proposal } = entry;
    const redraft = entry.redraft ?? (await this.currentRedraft(proposal.kind, proposal.id));
    const drafted = await this.draftingReceipt(proposal.kind, proposal.id);
    const redrafted =
      redraft > 1 ? await this.proposalReceipt(proposal.kind, proposal.id, redraft) : null;
    const receiptId = drafted ?? redrafted;
    if (!receiptId) return null;
    return {
      receiptId,
      redraftReceiptId: redrafted,
      kind: entry.kind,
      proposalKind: proposal.kind,
      proposalId: proposal.id,
      redraft,
      reason: entry.reason?.trim() || null,
      redraftsBeforeApproval: entry.kind === 'APPROVE' ? redraft - 1 : null,
      choiceLabel: entry.choiceLabel ?? null,
      editSize: entry.editSize ?? null,
      actorId: entry.actorId,
      createdAt: this.clock.now(),
    };
  }

  private async currentRedraft(kind: ProposalKind, proposalId: string): Promise<number> {
    const latest = await this.db.redraft.findFirst({
      where: { proposalKind: kind, proposalId, status: 'READY' },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    return latest?.number ?? 1;
  }

  /** The Receipt of the call that wrote Redraft `redraft` of the proposal. */
  private async proposalReceipt(
    kind: ProposalKind,
    proposalId: string,
    redraft: number,
  ): Promise<string | null> {
    const row = await this.db.receipt.findFirst({
      where: { proposalKind: kind, proposalId, redraft, success: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * The Receipt that drafted the proposal: the call that wrote it (Redraft 1); for a
   * Feature Suggestion, the call that generated its batch; for a proposal drafted in a
   * Conversation, the reply whose tool call made its Action Card.
   */
  private async draftingReceipt(kind: ProposalKind, proposalId: string): Promise<string | null> {
    const own = await this.proposalReceipt(kind, proposalId, 1);
    if (own) return own;
    if (kind === 'FEATURE_SUGGESTION') {
      const suggestion = await this.db.featureSuggestion.findUnique({
        where: { id: proposalId },
        select: { batchId: true },
      });
      const batch = suggestion
        ? await this.db.receipt.findFirst({
            where: { outputKind: 'FEATURE_SUGGESTION_BATCH', outputId: suggestion.batchId },
            select: { id: true },
          })
        : null;
      if (batch) return batch.id;
    }
    const cardKind = CARD_KIND[kind];
    if (!cardKind) return null;
    const card = await this.db.actionCard.findUnique({
      where: { kind_targetId: { kind: cardKind, targetId: proposalId } },
      select: { messageId: true },
    });
    if (!card) return null;
    const reply = await this.db.receipt.findFirst({
      where: { outputKind: 'CONVERSATION_MESSAGE', outputId: card.messageId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return reply?.id ?? null;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  /** Collection and retention: the Organization's, or the defaults before setup. */
  async settings(): Promise<ReceiptSettings> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        receiptsEnabled: true,
        receiptRetentionDays: true,
        aiMonthlyBudget: true,
      },
    });
    return {
      enabled: org?.receiptsEnabled ?? true,
      retentionDays: org?.receiptRetentionDays ?? DEFAULT_RECEIPT_RETENTION_DAYS,
      organizationId: org?.id ?? null,
      aiMonthlyBudget: org?.aiMonthlyBudget ?? null,
    };
  }

  async view(): Promise<ReceiptSettingsView> {
    const [{ enabled, retentionDays }, count, oldest] = await Promise.all([
      this.settings(),
      this.db.receipt.count(),
      this.db.receipt.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { enabled, retentionDays, count, oldestAt: oldest?.createdAt.toISOString() ?? null };
  }

  async update(input: ReceiptSettingsInput): Promise<ReceiptSettingsView> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!org) throw new UnprocessableEntityException('Run setup first');
    await this.db.organization.update({
      where: { id: org.id },
      data: {
        ...(input.enabled === undefined ? {} : { receiptsEnabled: input.enabled }),
        ...(input.retentionDays === undefined ? {} : { receiptRetentionDays: input.retentionDays }),
      },
    });
    return this.view();
  }

  // ─── Retention ────────────────────────────────────────────────────────────

  /**
   * Deletes Receipts older than the retention, with their outcomes, and any outcome older
   * than it. Run daily (`ReceiptsScheduler`); tests run it with a fake clock.
   */
  async purge(): Promise<{ receipts: number; outcomes: number }> {
    const { retentionDays } = await this.settings();
    const before = new Date(this.clock.now().getTime() - retentionDays * DAY_MS);
    const [outcomes, receipts] = await this.db.$transaction([
      this.db.receiptOutcome.deleteMany({
        where: { OR: [{ createdAt: { lt: before } }, { receipt: { createdAt: { lt: before } } }] },
      }),
      this.db.receipt.deleteMany({ where: { createdAt: { lt: before } } }),
    ]);
    return { receipts: receipts.count, outcomes: outcomes.count };
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  /**
   * Every Receipt kept, oldest first, as JSONL lines (`ReceiptExportLine`), read a page at
   * a time. People appear as ids stable within this export ("person-1"...); their names
   * and emails are replaced in every free text. Nothing of an Attachment is in a Receipt.
   */
  async *exportLines(): AsyncGenerator<string> {
    const users = await this.db.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true },
    });
    const people = new PeopleRedactor(users);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const rows: ExportRow[] = await this.db.receipt.findMany({
        where: cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: EXPORT_PAGE,
        include: { outcomes: true, redraftOutcomes: true, agentSkills: true },
      });
      for (const row of rows) yield `${JSON.stringify(exportLine(row, people))}\n`;
      const last = rows.at(-1);
      if (!last || rows.length < EXPORT_PAGE) return;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }
}

/** A Receipt's columns from what the call saw. */
async function receiptData(entry: ReceiptEntry): Promise<Prisma.ReceiptUncheckedCreateInput> {
  const promptName = TASK_SKILLS[entry.task];
  const { model, link, usage } = entry;
  return {
    task: entry.task,
    taskKind: AI_TASKS[entry.task].kind,
    promptName,
    promptVersion: entry.prompt?.version ?? (await skillVersion(promptName)),
    modelSource: model?.source ?? null,
    approvedModelId: model?.approvedModelId ?? null,
    modelName: model?.provider?.model ?? model?.name ?? null,
    providerKind: model ? providerKindOf(model) : null,
    language: entry.language ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    latencyMs: Math.max(0, Math.round(entry.latencyMs)),
    success: entry.success,
    error: entry.error,
    outputKind: link?.output?.kind ?? null,
    outputId: link?.output?.id ?? null,
    proposalKind: link?.proposal?.kind ?? null,
    proposalId: link?.proposal?.id ?? null,
    redraft: link?.proposal?.redraft ?? null,
    requestedById: link?.requestedById ?? null,
    evalRunId: link?.evalRunId ?? null,
    createdAt: entry.at,
    // The Agent Skills the call read (ticket 0078), each once.
    ...(link?.agentSkills?.length
      ? {
          agentSkills: {
            create: [...new Map(link.agentSkills.map((s) => [s.skillId, s])).values()].map((s) => ({
              skillId: s.skillId,
              versionId: s.versionId,
              name: s.name,
              pinned: s.pinned,
            })),
          },
        }
      : {}),
  };
}

function providerKindOf(model: ModelChoice): string | null {
  if (model.provider) return model.provider.provider;
  const prefix = model.name.split('/')[0]?.toLowerCase() ?? '';
  return ENV_PROVIDER[prefix] ?? null;
}

function exportLine(row: ExportRow, people: PeopleRedactor): ReceiptExportLine {
  const outcomes = [...row.outcomes, ...row.redraftOutcomes.filter((o) => o.receiptId !== row.id)]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(
      (o): ReceiptExportOutcome => ({
        kind: o.kind,
        at: o.createdAt.toISOString(),
        redraft: o.redraft,
        text: o.reason === null ? null : people.redact(o.reason),
        redraftsBeforeApproval: o.redraftsBeforeApproval,
        choiceLabel: o.choiceLabel,
        editSize: o.editSize,
        by: people.idOf(o.actorId),
      }),
    );
  return {
    format: RECEIPT_EXPORT_FORMAT,
    id: row.id,
    at: row.createdAt.toISOString(),
    task: row.task,
    taskKind: row.taskKind,
    prompt: { name: row.promptName, version: row.promptVersion },
    model: {
      source:
        row.modelSource === 'APPROVED_MODEL' || row.modelSource === 'ENV' ? row.modelSource : null,
      approvedModelId: row.approvedModelId,
      name: row.modelName,
      provider: row.providerKind,
    },
    language: row.language,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
    },
    latencyMs: row.latencyMs,
    success: row.success,
    error: row.error === null ? null : people.redact(row.error),
    output: row.outputKind && row.outputId ? { kind: row.outputKind, id: row.outputId } : null,
    proposal:
      row.proposalKind && row.proposalId && row.redraft
        ? { kind: row.proposalKind, id: row.proposalId, redraft: row.redraft }
        : null,
    requestedBy: people.idOf(row.requestedById),
    agentSkills: row.agentSkills.map((s) => ({ name: s.name, pinned: s.pinned })),
    outcomes,
  };
}
