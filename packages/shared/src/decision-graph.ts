import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import {
  DecisionRequestKind,
  DecisionRequestStatus,
  DecisionSource,
  DesignDocProposalReason,
  DesignDocVersionSource,
  SpecVersionSource,
  TeamRole,
} from './enums.ts';
import { ResponseWindowState } from './response-window.ts';

// The Decision Graph of a Feature (ticket 0067): its Decision Log drawn like a git network
// graph. The Spec Versions are the main lane; each sent Decision Request is a branch that
// forks at the Spec Version current when it was sent and merges at the Spec Version its
// approved Spec Proposal produced. Built from existing rows only.

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/**
 * Where a branch stands:
 * - WAITING: sent, waiting for a Decider (or a Claim);
 * - NEEDS_INFO: the Decider asked the Raiser a question;
 * - AWAITING_APPROVAL: decided, its Spec Proposal waits for approval;
 * - MERGED: its approved Spec Proposal produced a Spec Version;
 * - CLOSED: decided without a Spec change (its Spec Proposal was rejected);
 * - WITHDRAWN: the Raiser withdrew it.
 */
export const DecisionGraphBranchState = z.enum([
  'WAITING',
  'NEEDS_INFO',
  'AWAITING_APPROVAL',
  'MERGED',
  'CLOSED',
  'WITHDRAWN',
]);
export type DecisionGraphBranchState = z.infer<typeof DecisionGraphBranchState>;

/** The states of a branch not yet merged or closed: drawn dashed. */
export const OPEN_BRANCH_STATES: readonly DecisionGraphBranchState[] = [
  'WAITING',
  'NEEDS_INFO',
  'AWAITING_APPROVAL',
];

/** A node of the main lane: one Spec Version, including manual edits and reverts. */
export const DecisionGraphNode = z.object({
  id: Id,
  version: z.int().positive(),
  source: SpecVersionSource,
  summary: z.string().nullable(),
  /** For a REVERT, the version whose Markdown it restored. */
  revertedFrom: z.int().positive().nullable(),
  approvedBy: PersonRef,
  createdAt: Timestamp,
  /** The Decision Request whose approved Spec Proposal produced it (a merge), if any. */
  requestId: Id.nullable(),
});
export type DecisionGraphNode = z.infer<typeof DecisionGraphNode>;

/** One Redraft (ticket 0065) of a branch's Choices or of its Spec Proposal: a mark on it. */
export const DecisionGraphRedraft = z.object({
  of: z.enum(['CHOICES', 'SPEC_PROPOSAL']),
  /** 2 for the first Redraft; Redraft 1 is the proposal as first drafted and isn't listed. */
  number: z.int().min(2),
  createdAt: Timestamp,
});
export type DecisionGraphRedraft = z.infer<typeof DecisionGraphRedraft>;

/** A branch: one sent Decision Request, from the version it forked at to the one it produced. */
export const DecisionGraphBranch = z.object({
  requestId: Id,
  kind: DecisionRequestKind,
  title: z.string(),
  status: DecisionRequestStatus,
  state: DecisionGraphBranchState,
  raiser: PersonRef,
  /** Null while nobody has Claimed it. */
  decider: PersonRef.nullable(),
  deciderRole: TeamRole,
  sentAt: Timestamp,
  /** When it merged, closed or was withdrawn; null while open. */
  endedAt: Timestamp.nullable(),
  /** The Spec Version current when it was sent; null when the Feature had no Spec yet. */
  fromVersion: z.int().positive().nullable(),
  /** The Spec Version its approved Spec Proposal produced; null unless MERGED. */
  toVersion: z.int().positive().nullable(),
  /** The Decision, once made: the chosen Choice or the written answer, and where. */
  decision: z
    .object({
      decidedBy: PersonRef,
      onBehalfOf: PersonRef.nullable(),
      choice: z.object({ label: z.string(), title: z.string() }).nullable(),
      customAnswer: z.string().nullable(),
      source: DecisionSource,
      createdAt: Timestamp,
    })
    .nullable(),
  /** The Spec Proposal its Decision drafted, if any. */
  specProposalId: Id.nullable(),
  /** Oldest first. */
  redrafts: z.array(DecisionGraphRedraft),
  /** While WAITING or NEEDS_INFO: where it stands against its Response Window (0055). */
  responseWindow: ResponseWindowState.nullable(),
  /** "due in 2h", "overdue 1h", "escalated" at the time of the response; empty otherwise. */
  labels: z.array(z.string()),
});
export type DecisionGraphBranch = z.infer<typeof DecisionGraphBranch>;

/**
 * A Design Doc's sub-lane (ticket 0069): its approved versions, each drawn against the Spec
 * Version it follows, and the proposal waiting for approval. Stale when the latest Spec
 * changed what its latest version covers.
 */
export const DecisionGraphDesignDoc = z.object({
  /** The Platform's id, or `qa`. */
  key: z.string(),
  /** "Back-End", or "QA". */
  name: z.string(),
  stale: z.boolean(),
  /** Oldest first. */
  versions: z.array(
    z.object({
      version: z.int().positive(),
      specVersion: z.int().positive(),
      source: DesignDocVersionSource,
      approvedBy: PersonRef,
      createdAt: Timestamp,
    }),
  ),
  pending: z
    .object({
      reason: DesignDocProposalReason,
      specVersion: z.int().positive(),
      createdAt: Timestamp,
    })
    .nullable(),
});
export type DecisionGraphDesignDoc = z.infer<typeof DecisionGraphDesignDoc>;

/** `GET /features/:id/decision-graph`: 404 for anyone who can't read the Feature. */
export const DecisionGraphView = z.object({
  featureId: Id,
  /** The main lane, oldest first. */
  nodes: z.array(DecisionGraphNode),
  /** Sent Decision Requests (never drafts), oldest sent first. */
  branches: z.array(DecisionGraphBranch),
  /** The Design Docs drafted so far, as sub-lanes under the main one (ticket 0069). */
  designDocs: z.array(DecisionGraphDesignDoc),
});
export type DecisionGraphView = z.infer<typeof DecisionGraphView>;
