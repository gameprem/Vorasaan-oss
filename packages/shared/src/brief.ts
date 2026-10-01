import { z } from 'zod';
import { RecordedModel } from './ai-settings.ts';
import { PersonRef } from './decision-request.ts';
import { BriefVersionSource, ProposalStatus } from './enums.ts';
import { SpecDiff, SpecDiffQuery } from './spec.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/**
 * The empty Project Brief a new Project starts from: section headings only
 * (REQUIREMENT §3.8). It is not stored; `GET /projects/:id/brief` returns it as
 * version 0 until someone saves v1.
 */
export const BRIEF_TEMPLATE = `# Project Brief

## Business goals

## Target users

## Current capabilities

## Constraints

## Non-goals
`;

export const BriefVersionView = z.object({
  id: Id,
  projectId: Id,
  version: z.int().positive(),
  markdown: z.string(),
  source: BriefVersionSource,
  summary: z.string().nullable(),
  approvedBy: PersonRef,
  /** For a REVERT, the version whose Markdown it restored. */
  revertedFrom: z.int().positive().nullable(),
  /** The model that drafted its proposal in a Conversation (ticket 0054); null otherwise. */
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type BriefVersionView = z.infer<typeof BriefVersionView>;

/**
 * The current Project Brief. Before anyone saves one, `version` is 0, `current`
 * is null and `markdown` is BRIEF_TEMPLATE.
 */
export const ProjectBriefView = z.object({
  projectId: Id,
  version: z.int().nonnegative(),
  markdown: z.string(),
  current: BriefVersionView.nullable(),
  /** Whether the viewer may edit, revert and approve (an Admin or a PO of one of the Project's Teams). */
  canEdit: z.boolean(),
});
export type ProjectBriefView = z.infer<typeof ProjectBriefView>;

/** `POST /projects/:id/brief-versions`. `baseVersion` is the version the edit started from (0 for the template). */
export const WriteBriefInput = z.object({
  markdown: z.string().trim().min(1, 'The Project Brief is empty'),
  summary: z.string().trim().max(200).optional(),
  baseVersion: z.int().nonnegative(),
});
export type WriteBriefInput = z.infer<typeof WriteBriefInput>;

/** Restores an earlier Brief Version as a new one. `baseVersion` guards against a stale view. */
export const RevertBriefInput = z.object({
  summary: z.string().trim().max(200).optional(),
  baseVersion: z.int().nonnegative(),
});
export type RevertBriefInput = z.infer<typeof RevertBriefInput>;

/** `from=0` compares against an empty Brief, so v1 can be shown as all additions. */
export const BriefDiffQuery = SpecDiffQuery;
export type BriefDiffQuery = z.infer<typeof BriefDiffQuery>;

/** The same line diff as the Spec's. */
export const BriefDiff = SpecDiff;
export type BriefDiff = z.infer<typeof BriefDiff>;

/** A drafted Brief change awaiting approval; carries both sides for rendering the diff. */
export const BriefProposalView = z.object({
  id: Id,
  projectId: Id,
  source: BriefVersionSource,
  status: ProposalStatus,
  approver: PersonRef,
  baseVersion: z.int().positive().nullable(),
  baseMarkdown: z.string(),
  proposedMarkdown: z.string(),
  /** One line on what the proposal changes; it becomes the Brief Version's summary. */
  summary: z.string().nullable(),
  /** The Brief Version it became, once APPROVED. */
  resultVersion: z.int().positive().nullable(),
  /** The model that drafted it in a Conversation (ticket 0054); null otherwise. */
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type BriefProposalView = z.infer<typeof BriefProposalView>;
