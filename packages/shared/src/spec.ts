import { z } from 'zod';
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
  createdAt: Timestamp,
});
export type SpecVersionView = z.infer<typeof SpecVersionView>;

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
  createdAt: Timestamp,
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

export const DecideResult = z.object({
  request: DecisionRequestView,
  proposal: SpecProposalView,
});
export type DecideResult = z.infer<typeof DecideResult>;
