import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import {
  PromptActivationKind,
  PromptAnalysisStatus,
  PromptAnalysisTrigger,
  PromptEvalRunStatus,
  PromptVersionStatus,
  ProposalKind,
  ReceiptOutcomeKind,
} from './enums.ts';
import { SpecDiffLine } from './spec.ts';

const Timestamp = z.iso.datetime();

// ─── Prompt Versions (ADR 0015, ticket 0071) ────────────────────────────────
// The prompts in packages/skills are the defaults. An Organization can hold its own
// Prompt Versions of any of them: numbered, immutable, approved by an Admin, one active
// per prompt. Number 0 always means the built-in default.

/** The number that stands for the built-in default in every request and view. */
export const DEFAULT_PROMPT_NUMBER = 0;

/** The longest Prompt Version accepted, in characters. */
export const MAX_PROMPT_TEMPLATE_LENGTH = 100_000;

/** A version number: 0 for the built-in default, else a Prompt Version's number. */
const VersionNumber = z.int().min(0);

/** The version of a prompt that is active, and since when (null for the default never changed). */
export const ActivePromptView = z.object({
  number: VersionNumber,
  /** As Receipts name it: `default@<hash>` or `v<n>@<hash>`. */
  version: z.string(),
  since: Timestamp.nullable(),
  by: PersonRef.nullable(),
});
export type ActivePromptView = z.infer<typeof ActivePromptView>;

/** One row of Settings → AI → Prompts. */
export const PromptSummaryView = z.object({
  /** The packages/skills name, e.g. `generate-choices`. */
  name: z.string(),
  /** The AI tasks that render it, e.g. `generateChoices`. */
  tasks: z.array(z.string()),
  active: ActivePromptView,
  /** Prompt Versions held, any status. */
  versions: z.int().min(0),
  /** Prompt Versions waiting for approval. */
  proposed: z.int().min(0),
  /** Checked-in eval cases for it. */
  evalCases: z.int().min(0),
  /** Whether approved Receipts of it can be replayed. */
  replayable: z.boolean(),
  /** Outcomes linked to its Receipts since its last analysis (ticket 0072). */
  newFeedback: z.int().min(0),
});
export type PromptSummaryView = z.infer<typeof PromptSummaryView>;

/** `GET /settings/ai/prompts` (Admins only). */
export const PromptsView = z.object({
  prompts: z.array(PromptSummaryView),
  /** The AI analyses a prompt's feedback after this many new outcomes; 0: only when asked. */
  analysisAfter: z.int().min(0),
});
export type PromptsView = z.infer<typeof PromptsView>;

export const PromptVersionView = z.object({
  id: z.uuid(),
  number: z.int().min(1),
  version: z.string(),
  status: PromptVersionStatus,
  template: z.string(),
  note: z.string().nullable(),
  proposedBy: PersonRef.nullable(),
  createdAt: Timestamp,
  approvedBy: PersonRef.nullable(),
  approvedAt: Timestamp.nullable(),
  declinedBy: PersonRef.nullable(),
  declinedAt: Timestamp.nullable(),
  declineReason: z.string().nullable(),
  active: z.boolean(),
  /** Proposed by the AI from its feedback (ticket 0072): the analysis it came from. */
  analysisId: z.uuid().nullable(),
  /** The AI's reasons for the changes, from the patterns it found. */
  rationale: z.string().nullable(),
});
export type PromptVersionView = z.infer<typeof PromptVersionView>;

/** One change of the active version: an approval or a rollback. */
export const PromptActivationView = z.object({
  number: VersionNumber,
  kind: PromptActivationKind,
  by: PersonRef.nullable(),
  at: Timestamp,
});
export type PromptActivationView = z.infer<typeof PromptActivationView>;

export const PromptEvalUsage = z.object({
  inputTokens: z.int().min(0).nullable(),
  outputTokens: z.int().min(0).nullable(),
  cacheReadTokens: z.int().min(0).nullable(),
  cacheWriteTokens: z.int().min(0).nullable(),
});
export type PromptEvalUsage = z.infer<typeof PromptEvalUsage>;

/** What an eval run includes: the checked-in eval cases, a replay of approved Receipts, or both. */
export const PromptEvalSource = z.enum(['CHECKED_IN', 'REPLAY']);
export type PromptEvalSource = z.infer<typeof PromptEvalSource>;

/** The eval set a case belongs to: a checked-in set (`choices`, `grilling`...) or `replay`. */
export const REPLAY_EVAL_SET = 'replay';

export const PromptEvalSetScore = z.object({
  set: z.string(),
  /** The mean of its cases' scores, 0 to 1; null before any case is scored. */
  score: z.number().min(0).max(1).nullable(),
  cases: z.int().min(0),
});
export type PromptEvalSetScore = z.infer<typeof PromptEvalSetScore>;

export const PromptEvalRunSummary = z.object({
  id: z.uuid(),
  promptName: z.string(),
  number: VersionNumber,
  version: z.string(),
  model: z.object({
    approvedModelId: z.string().nullable(),
    displayName: z.string(),
    name: z.string(),
  }),
  sources: z.array(PromptEvalSource),
  status: PromptEvalRunStatus,
  total: z.int().min(0),
  done: z.int().min(0),
  /** The mean of every case's score, 0 to 1; null until the run is done. */
  score: z.number().min(0).max(1).nullable(),
  setScores: z.array(PromptEvalSetScore),
  error: z.string().nullable(),
  /** Summed from the run's Receipts. */
  usage: PromptEvalUsage,
  startedBy: PersonRef.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type PromptEvalRunSummary = z.infer<typeof PromptEvalRunSummary>;

export const PromptEvalCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().nullable(),
});
export type PromptEvalCheck = z.infer<typeof PromptEvalCheck>;

export const PromptEvalCaseView = z.object({
  /** Stable across runs: two runs are compared case by case on it. */
  key: z.string(),
  set: z.string(),
  name: z.string(),
  /** The share of its checks passed, 0 to 1 (0 when the call failed). */
  score: z.number().min(0).max(1),
  checks: z.array(PromptEvalCheck),
  /** The output, as a sample; null when the call failed. */
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  /** A replay case: the approved Receipt it replayed. */
  receiptId: z.string().nullable(),
  latencyMs: z.int().min(0),
});
export type PromptEvalCaseView = z.infer<typeof PromptEvalCaseView>;

export const PromptEvalRunView = PromptEvalRunSummary.extend({
  cases: z.array(PromptEvalCaseView),
});
export type PromptEvalRunView = z.infer<typeof PromptEvalRunView>;

/** `POST /settings/ai/prompts/:name/versions`: a Prompt Version written by hand, proposed. */
export const CreatePromptVersionInput = z.strictObject({
  template: z.string().trim().min(1).max(MAX_PROMPT_TEMPLATE_LENGTH),
  note: z.string().trim().max(2_000).nullish(),
});
export type CreatePromptVersionInput = z.infer<typeof CreatePromptVersionInput>;

export const DeclinePromptVersionInput = z.strictObject({
  reason: z.string().trim().max(2_000).optional(),
});
export type DeclinePromptVersionInput = z.infer<typeof DeclinePromptVersionInput>;

/** `POST /settings/ai/prompts/:name/rollback`: make an earlier approved version (or 0, the default) active. */
export const RollbackPromptInput = z.strictObject({ version: VersionNumber });
export type RollbackPromptInput = z.infer<typeof RollbackPromptInput>;

const NumberParam = z.string().regex(/^\d+$/, 'Expected a version number').transform(Number);

/** `GET /settings/ai/prompts/:name/diff?from=&to=`: 0 is the built-in default. */
export const PromptDiffQuery = z.object({
  from: NumberParam.pipe(VersionNumber),
  to: NumberParam.pipe(VersionNumber),
});
export type PromptDiffQuery = z.infer<typeof PromptDiffQuery>;

/** A line diff of two versions of a prompt, computed like a Spec Version diff. */
export const PromptDiff = z.object({
  from: VersionNumber,
  to: VersionNumber,
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  lines: z.array(SpecDiffLine),
});
export type PromptDiff = z.infer<typeof PromptDiff>;

/** `POST /settings/ai/prompts/:name/evals`: run evals on a version, on an Approved Model. */
export const StartPromptEvalInput = z.strictObject({
  version: VersionNumber,
  approvedModelId: z.uuid(),
  sources: z.array(PromptEvalSource).min(1).max(2),
});
export type StartPromptEvalInput = z.infer<typeof StartPromptEvalInput>;

/** `GET /settings/ai/prompts/:name/evals/compare?a=&b=`. */
export const PromptEvalCompareQuery = z.object({ a: z.uuid(), b: z.uuid() });
export type PromptEvalCompareQuery = z.infer<typeof PromptEvalCompareQuery>;

const ComparedCase = z.object({
  score: z.number().min(0).max(1),
  checks: z.array(PromptEvalCheck),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
});

/** Two runs side by side: per eval set and per case, with sample outputs. */
export const PromptEvalComparison = z.object({
  a: PromptEvalRunSummary,
  b: PromptEvalRunSummary,
  sets: z.array(
    z.object({
      set: z.string(),
      a: z.number().min(0).max(1).nullable(),
      b: z.number().min(0).max(1).nullable(),
    }),
  ),
  cases: z.array(
    z.object({
      key: z.string(),
      set: z.string(),
      name: z.string(),
      /** Null when that run has no such case. */
      a: ComparedCase.nullable(),
      b: ComparedCase.nullable(),
    }),
  ),
});
export type PromptEvalComparison = z.infer<typeof PromptEvalComparison>;

// ─── The AI proposes Prompt Versions (ADR 0015, ticket 0072) ────────────────
// The AI reads the outcomes linked to a prompt's Receipts, names the patterns in them and
// proposes a Prompt Version from them. Evals run on it, and on the active version, at once.
// Only an Admin's Approve makes it active; Request changes asks the AI for a Redraft.

/** The default number of new outcomes after which a prompt's feedback is analysed. */
export const DEFAULT_PROMPT_ANALYSIS_AFTER = 20;

/** One outcome a pattern cites. */
export const PromptPatternCase = z.object({
  outcomeId: z.string(),
  receiptId: z.string(),
  kind: ReceiptOutcomeKind,
  /** DECLINE: the reason; REQUEST_CHANGES: the feedback. Null once retention deleted the outcome. */
  text: z.string().nullable(),
  redraft: z.int().min(1),
  proposal: z.object({ kind: ProposalKind, id: z.string() }),
  /** The web app's path to the proposal; null once it is gone. */
  href: z.string().nullable(),
  at: Timestamp,
});
export type PromptPatternCase = z.infer<typeof PromptPatternCase>;

/** A pattern the AI named in a prompt's feedback, with the cases it found it in. */
export const PromptPattern = z.object({
  title: z.string(),
  description: z.string(),
  /** How many cases show it. */
  count: z.int().min(1),
  cases: z.array(PromptPatternCase),
});
export type PromptPattern = z.infer<typeof PromptPattern>;

/** One reading of a prompt's feedback by the AI. */
export const PromptAnalysisView = z.object({
  id: z.uuid(),
  promptName: z.string(),
  trigger: PromptAnalysisTrigger,
  status: PromptAnalysisStatus,
  /** How many outcomes it read. */
  outcomes: z.int().min(0),
  /** Most cases first; empty while running, or when it found none. */
  patterns: z.array(PromptPattern),
  error: z.string().nullable(),
  /** The Prompt Version it proposed, if any. */
  proposed: z.int().min(1).nullable(),
  requestedBy: PersonRef.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type PromptAnalysisView = z.infer<typeof PromptAnalysisView>;

/** A prompt's feedback: what is new since its last analysis, and its analyses, newest first. */
export const PromptFeedbackView = z.object({
  /** Outcomes linked to its Receipts since its last analysis (all of them before the first). */
  newOutcomes: z.int().min(0),
  /** Outcomes in all, kept by retention. */
  outcomes: z.int().min(0),
  analysisAfter: z.int().min(0),
  analyses: z.array(PromptAnalysisView),
});
export type PromptFeedbackView = z.infer<typeof PromptFeedbackView>;

/**
 * `GET /settings/ai/prompts/:name/versions/:number/proposal`: a Prompt Version the AI
 * proposed, as an Admin decides it: the patterns behind it, its rationale, the diff from the
 * version active now, and the evals on both with their sample outputs side by side.
 */
export const PromptProposalView = z.object({
  version: PromptVersionView,
  analysis: PromptAnalysisView.nullable(),
  /** The version active now (0: the default). */
  activeNumber: VersionNumber,
  /** From the version it was evaluated against (the one active when it was proposed) to it. */
  diff: PromptDiff,
  /** The run on the version active when it was proposed or redrafted, and on the proposal. */
  before: PromptEvalRunSummary.nullable(),
  after: PromptEvalRunSummary.nullable(),
  /** Both runs side by side, once both are done. */
  comparison: PromptEvalComparison.nullable(),
  /** Why no evals ran on it, when none did. */
  evalsNote: z.string().nullable(),
});
export type PromptProposalView = z.infer<typeof PromptProposalView>;

/** `PUT /settings/ai/prompt-analysis`: after how many new outcomes the AI analyses a prompt. */
export const PromptAnalysisSettingsInput = z.strictObject({
  analysisAfter: z.int().min(0).max(10_000),
});
export type PromptAnalysisSettingsInput = z.infer<typeof PromptAnalysisSettingsInput>;

/** `GET /settings/ai/prompts/:name`: the prompt, its versions, history and eval runs. */
export const PromptDetailView = z.object({
  name: z.string(),
  tasks: z.array(z.string()),
  default: z.object({ version: z.string(), template: z.string() }),
  active: ActivePromptView,
  /** Newest first. */
  versions: z.array(PromptVersionView),
  /** Every approval and rollback, newest first. */
  history: z.array(PromptActivationView),
  /** The checked-in eval sets that have cases for this prompt. */
  evalSets: z.array(z.object({ set: z.string(), cases: z.int().min(0) })),
  replay: z.object({
    supported: z.boolean(),
    /** Approved Receipts a replay would pick now. */
    receipts: z.int().min(0),
  }),
  /** Newest first. */
  runs: z.array(PromptEvalRunSummary),
  /** Its feedback and the AI's analyses of it (ticket 0072). */
  feedback: PromptFeedbackView,
});
export type PromptDetailView = z.infer<typeof PromptDetailView>;
