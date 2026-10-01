import { z } from 'zod';
import { RecordedModel } from './ai-settings.ts';
import { DecisionRequestView, PersonRef } from './decision-request.ts';
import { DecisionRequestKind, ProposalStatus, SpecVersionSource } from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

export const SpecVersionView = z.object({
  id: Id,
  featureId: Id,
  version: z.int().positive(),
  markdown: z.string(),
  source: SpecVersionSource,
  summary: z.string().nullable(),
  approvedBy: PersonRef,
  /** For a REVERT, the version whose Markdown it restored. */
  revertedFrom: z.int().positive().nullable(),
  /** The model that drafted its proposal in a Conversation (ticket 0054); null otherwise. */
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type SpecVersionView = z.infer<typeof SpecVersionView>;

/** Restores an earlier Spec Version as a new one. `baseVersion` guards against a stale view. */
export const RevertSpecInput = z.object({
  summary: z.string().trim().max(200).optional(),
  baseVersion: z.int().nonnegative(),
});
export type RevertSpecInput = z.infer<typeof RevertSpecInput>;

const VersionParam = z.string().regex(/^\d+$/, 'Expected a version number').transform(Number);

/** `from=0` compares against an empty Spec, so v1 can be shown as all additions. */
export const SpecDiffQuery = z.object({
  from: VersionParam.pipe(z.int().nonnegative()),
  to: VersionParam.pipe(z.int().positive()),
});
export type SpecDiffQuery = z.infer<typeof SpecDiffQuery>;

export const SpecDiffLine = z.object({
  kind: z.enum(['UNCHANGED', 'ADDED', 'REMOVED']),
  text: z.string(),
  /** 1-based line number in `from`; null for an added line. */
  fromLine: z.int().positive().nullable(),
  /** 1-based line number in `to`; null for a removed line. */
  toLine: z.int().positive().nullable(),
});
export type SpecDiffLine = z.infer<typeof SpecDiffLine>;

/** A line diff computed on the server so the web and CLI render the same thing. */
export const SpecDiff = z.object({
  from: z.int().nonnegative(),
  to: z.int().positive(),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  lines: z.array(SpecDiffLine),
});
export type SpecDiff = z.infer<typeof SpecDiff>;

/** Carries both sides so a client can render the diff without another request. */
export const SpecProposalView = z.object({
  id: Id,
  featureId: Id,
  source: SpecVersionSource,
  status: ProposalStatus,
  approver: PersonRef,
  baseVersion: z.int().positive().nullable(),
  baseMarkdown: z.string(),
  proposedMarkdown: z.string(),
  decisionRequestId: Id.nullable(),
  /** The model that drafted it in a Conversation (ticket 0054); null otherwise. */
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type SpecProposalView = z.infer<typeof SpecProposalView>;

export const DecisionLogEntry = z.object({
  decisionId: Id,
  decisionRequestId: Id,
  requestTitle: z.string(),
  kind: DecisionRequestKind,
  decidedBy: PersonRef,
  onBehalfOf: PersonRef.nullable(),
  /** The picked Choice's label and title, or null for a free-text answer. */
  choice: z.object({ label: z.string(), title: z.string() }).nullable(),
  customAnswer: z.string().nullable(),
  rationale: z.string().nullable(),
  /** The Spec Version this Decision produced, if its proposal was approved. */
  specVersion: z.int().positive().nullable(),
  /** The model that drafted the request's AI Choices in a Conversation (ticket 0054); null otherwise. */
  choicesDraftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

export const DecideResult = z.object({
  request: DecisionRequestView,
  proposal: SpecProposalView,
});
export type DecideResult = z.infer<typeof DecideResult>;
