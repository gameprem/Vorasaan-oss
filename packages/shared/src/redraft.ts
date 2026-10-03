import { z } from 'zod';
import { RecordedModel } from './ai-settings.ts';
import { ChoiceDraft, PersonRef } from './decision-request.ts';
import { diffLines } from './diff.ts';
import { ProposalKind, RedraftStatus, SuggestionLevel } from './enums.ts';
import { SpecDiffLine } from './spec.ts';

const Timestamp = z.iso.datetime();

// ─── Request changes and Redrafts (ADR 0013, ticket 0065) ───────────────────
// The third answer to an AI proposal: a person says what to change, and the AI writes a
// Redraft of the same proposal. Redraft 1 is the proposal as first drafted. Nothing
// changes until someone approves, and Approve applies only the latest Redraft.

/** How many times a proposal can be redrafted, unless VORASAAN_MAX_REDRAFTS says otherwise. */
export const DEFAULT_MAX_REDRAFTS = 10;
/** The longest feedback one Request changes takes. */
export const MAX_FEEDBACK_CHARS = 4_000;

/**
 * The part of the proposal the feedback is about, when the person pointed at one:
 * - CHOICE: one Choice of a Decision Request, by its label;
 * - SECTION: a section of a Markdown proposal (Spec or Brief), by its heading's text;
 * - LINES: lines of a Markdown proposal, 1-based and inclusive, as the current Redraft numbers them.
 */
export const RedraftPointer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CHOICE'), label: z.string().trim().min(1).max(3) }),
  z.strictObject({ kind: z.literal('SECTION'), heading: z.string().trim().min(1).max(300) }),
  z
    .strictObject({
      kind: z.literal('LINES'),
      from: z.int().min(1).max(100_000),
      to: z.int().min(1).max(100_000),
    })
    .refine((p) => p.from <= p.to, { message: '`from` must not be after `to`' }),
]);
export type RedraftPointer = z.infer<typeof RedraftPointer>;

/**
 * `POST …/request-changes` (a Spec Proposal, a Brief Proposal, a Feature Suggestion, a
 * Decision Request's Choices, or an Action Card): what to change, in the person's own
 * words, and optionally the part of the proposal it is about.
 */
export const RequestChangesInput = z.strictObject({
  feedback: z.string().trim().min(1).max(MAX_FEEDBACK_CHARS),
  pointer: RedraftPointer.optional(),
});
export type RequestChangesInput = z.infer<typeof RequestChangesInput>;

/** One Redraft's proposal, as the proposal held it. */
export const RedraftContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CHOICES'), choices: z.array(ChoiceDraft) }),
  /** A Spec Proposal or a Brief Proposal (with its one-line summary, when it has one). */
  z.object({
    kind: z.literal('MARKDOWN'),
    markdown: z.string(),
    summary: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('FEATURE_SUGGESTION'),
    title: z.string(),
    rationale: z.string(),
    businessValue: z.string(),
    effort: SuggestionLevel,
    risk: SuggestionLevel,
  }),
]);
export type RedraftContent = z.infer<typeof RedraftContent>;

const LEVEL = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' } as const;

/**
 * A Redraft as Markdown text, the way it is diffed against another (like Spec Versions,
 * 0020): a Markdown proposal as it is; Choices and a Feature Suggestion written out.
 */
export function redraftText(content: RedraftContent): string {
  switch (content.kind) {
    case 'MARKDOWN':
      return content.markdown;
    case 'CHOICES':
      return content.choices
        .map((c) =>
          [
            `## ${c.label}. ${c.title}`,
            '',
            c.description,
            '',
            `- Scope: ${c.impactScope}`,
            `- Time: ${c.impactTime}`,
            `- Risk: ${c.impactRisk}`,
          ].join('\n'),
        )
        .join('\n\n');
    case 'FEATURE_SUGGESTION':
      return [
        `# ${content.title}`,
        '',
        content.rationale,
        '',
        '## Business value',
        '',
        content.businessValue,
        '',
        `Effort: ${LEVEL[content.effort]} · Risk: ${LEVEL[content.risk]}`,
      ].join('\n');
  }
}

/** A line diff between two Redraft numbers of one proposal. */
export const RedraftDiff = z.object({
  from: z.int().positive(),
  to: z.int().positive(),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  lines: z.array(SpecDiffLine),
});
export type RedraftDiff = z.infer<typeof RedraftDiff>;

/** The diff between two Redrafts' texts (`redraftText`). */
export function diffRedrafts(
  from: { number: number; text: string },
  to: { number: number; text: string },
): RedraftDiff {
  const lines = diffLines(from.text, to.text);
  return {
    from: from.number,
    to: to.number,
    added: lines.filter((l) => l.kind === 'ADDED').length,
    removed: lines.filter((l) => l.kind === 'REMOVED').length,
    lines,
  };
}

export const RedraftView = z.object({
  number: z.int().positive(),
  /** WRITING while the AI writes it: then `content` is null and `text` empty. */
  status: RedraftStatus,
  content: RedraftContent.nullable(),
  /** `redraftText(content)`, for diffing any two. */
  text: z.string(),
  /** What the person asked to change; null for Redraft 1. */
  feedback: z.string().nullable(),
  pointer: RedraftPointer.nullable(),
  /** Who asked for it; null for Redraft 1. */
  requestedBy: PersonRef.nullable(),
  /** What the AI says it changed. */
  summary: z.string().nullable(),
  /** Preferences the AI found in the feedback (language, length, style). */
  preferences: z.array(z.string()),
  /** The model that wrote it, when it was recorded (0054). */
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type RedraftView = z.infer<typeof RedraftView>;

/**
 * A proposal's Redrafts, oldest first (`GET …/redrafts`). A proposal never redrafted has
 * only Redraft 1, read from the proposal itself. `current` is the latest READY one: what
 * the proposal shows and what Approve applies.
 */
export const ProposalRedraftsView = z.object({
  kind: ProposalKind,
  proposalId: z.uuid(),
  current: z.int().positive(),
  /** A Redraft is being written: Approve and another Request changes wait for it. */
  writing: z.boolean(),
  /** How many Request changes the proposal takes in all, and how many are left. */
  limit: z.int().nonnegative(),
  left: z.int().nonnegative(),
  /** Whether the viewer may Request changes now, and if not, why. */
  canRequestChanges: z.boolean(),
  reason: z.string().nullable(),
  redrafts: z.array(RedraftView),
});
export type ProposalRedraftsView = z.infer<typeof ProposalRedraftsView>;

/** `POST …/request-changes` answers with the new Redraft, every Redraft, and the diff from the one before. */
export const RequestChangesResult = z.object({
  redraft: RedraftView,
  redrafts: ProposalRedraftsView,
  diff: RedraftDiff,
});
export type RequestChangesResult = z.infer<typeof RequestChangesResult>;

/** `GET …/redrafts/diff?from=1&to=2`. */
export const RedraftDiffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});
export type RedraftDiffQuery = z.infer<typeof RedraftDiffQuery>;

/**
 * One Request changes as an eval case for the redraft prompts (`GET /redrafts/eval-cases`,
 * Admins only): the Redraft before, the feedback, and what the AI wrote.
 */
export const RedraftEvalCase = z.object({
  kind: ProposalKind,
  proposalId: z.uuid(),
  number: z.int().positive(),
  feedback: z.string(),
  pointer: RedraftPointer.nullable(),
  /** The feedback given on earlier Redrafts of the same proposal, oldest first. */
  earlierFeedback: z.array(z.string()),
  before: z.string(),
  after: z.string(),
  preferences: z.array(z.string()),
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type RedraftEvalCase = z.infer<typeof RedraftEvalCase>;

/** A Redraft started or finished (or failed, leaving the proposal as it was). */
export const ProposalRedraftedEvent = z.object({
  kind: ProposalKind,
  proposalId: z.uuid(),
  number: z.int().positive(),
  status: z.enum(['WRITING', 'READY', 'FAILED']),
});
export type ProposalRedraftedEvent = z.infer<typeof ProposalRedraftedEvent>;
