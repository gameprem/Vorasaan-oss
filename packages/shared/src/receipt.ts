import { z } from 'zod';
import { ProposalKind, ReceiptOutcomeKind, ReceiptOutputKind } from './enums.ts';

const Timestamp = z.iso.datetime();
const Tokens = z.int().min(0).nullable();

// ─── Receipts (ADR 0015, ticket 0070) ───────────────────────────────────────
// Every AI call leaves a Receipt, and what people did with its proposal is linked to it:
// the Learning Loop's raw material. A Receipt never holds the prompt or the reply.

/** How long Receipts are kept unless an Admin says otherwise. */
export const DEFAULT_RECEIPT_RETENTION_DAYS = 90;
/** The longest retention an Admin may set: ten years. */
export const MAX_RECEIPT_RETENTION_DAYS = 3650;

/** `GET /settings/ai/receipts`: collection, retention, and how many Receipts are kept. */
export const ReceiptSettingsView = z.object({
  enabled: z.boolean(),
  retentionDays: z.int().min(1).max(MAX_RECEIPT_RETENTION_DAYS),
  /** Receipts kept now. */
  count: z.int().min(0),
  /** When the oldest one kept was written; null with none. */
  oldestAt: Timestamp.nullable(),
});
export type ReceiptSettingsView = z.infer<typeof ReceiptSettingsView>;

/** `PUT /settings/ai/receipts` (Admins only): either or both. */
export const ReceiptSettingsInput = z
  .strictObject({
    enabled: z.boolean().optional(),
    retentionDays: z.int().min(1).max(MAX_RECEIPT_RETENTION_DAYS).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.retentionDays !== undefined, {
    message: 'Give `enabled`, `retentionDays` or both',
  });
export type ReceiptSettingsInput = z.infer<typeof ReceiptSettingsInput>;

/** The `format` of every line of the export; a breaking change bumps its number. */
export const RECEIPT_EXPORT_FORMAT = 'vorasaan.receipt/1';

/**
 * A person in the export: a stable id within one export ("person-1", "person-2"...),
 * never their name or email. The same person has the same id throughout one export.
 */
export const ExportPerson = z.string().regex(/^person-\d+$/);

/** One human outcome of a Receipt's proposal, as exported. */
export const ReceiptExportOutcome = z.object({
  kind: ReceiptOutcomeKind,
  at: Timestamp,
  /** The Redraft it was given on (1 for the proposal as first drafted). */
  redraft: z.int().min(1),
  /** DECLINE: the reason; REQUEST_CHANGES: the feedback. Names and emails are replaced. */
  text: z.string().nullable(),
  /** APPROVE: the Redrafts written before it. */
  redraftsBeforeApproval: z.int().min(0).nullable(),
  /** APPROVE of Choices: the label of the Choice decided. */
  choiceLabel: z.string().nullable(),
  /** MANUAL_EDIT: lines added plus lines removed. */
  editSize: z.int().min(0).nullable(),
  by: ExportPerson.nullable(),
});
export type ReceiptExportOutcome = z.infer<typeof ReceiptExportOutcome>;

/** One line of `GET /settings/ai/receipts/export` (JSONL): a Receipt with its outcomes. */
export const ReceiptExportLine = z.object({
  format: z.literal(RECEIPT_EXPORT_FORMAT),
  id: z.uuid(),
  at: Timestamp,
  /** The AI task, e.g. `generateChoices`, and its Settings task, e.g. `CHOICES`. */
  task: z.string(),
  taskKind: z.string(),
  prompt: z.object({
    name: z.string(),
    /** `default@<hash>` for the built-in prompt. */
    version: z.string(),
  }),
  model: z.object({
    source: z.enum(['APPROVED_MODEL', 'ENV']).nullable(),
    approvedModelId: z.string().nullable(),
    name: z.string().nullable(),
    provider: z.string().nullable(),
  }),
  /** The Reply Language asked for ("en", "th"). */
  language: z.string().nullable(),
  usage: z.object({
    inputTokens: Tokens,
    outputTokens: Tokens,
    cacheReadTokens: Tokens,
    cacheWriteTokens: Tokens,
  }),
  latencyMs: z.int().min(0),
  success: z.boolean(),
  error: z.string().nullable(),
  /** What it produced, by reference. */
  output: z.object({ kind: ReceiptOutputKind, id: z.string() }).nullable(),
  /** The proposal it drafted or redrafted, and which Redraft. */
  proposal: z.object({ kind: ProposalKind, id: z.string(), redraft: z.int().min(1) }).nullable(),
  requestedBy: ExportPerson.nullable(),
  /** The Agent Skills the call read (ticket 0078), by name and pinned commit or zip hash. */
  agentSkills: z.array(z.object({ name: z.string(), pinned: z.string() })),
  /**
   * What people did with it: on the Receipt that drafted a proposal, every outcome of the
   * proposal; on a Redraft's Receipt, the outcomes given on that Redraft.
   */
  outcomes: z.array(ReceiptExportOutcome),
});
export type ReceiptExportLine = z.infer<typeof ReceiptExportLine>;

/** `POST /spec-proposals/:id/reject` and `/brief-proposals/:id/reject`: an optional reason. */
export const RejectProposalInput = z
  .strictObject({ reason: z.string().trim().min(1).max(1000).optional() })
  .optional();
export type RejectProposalInput = z.infer<typeof RejectProposalInput>;
