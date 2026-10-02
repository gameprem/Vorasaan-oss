import { z } from 'zod';
import {
  DecisionRequestKind,
  DecisionRequestStatus,
  ProposalStatus,
  RequestMessageKind,
  TeamRole,
} from './enums.ts';
import { RequestHistoryEntryView, ResponseWindow, ResponseWindowState } from './response-window.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();
const Text = z.string().trim().min(1);

// ─── Choices ────────────────────────────────────────────────────────────────

export const ChoiceDraft = z.object({
  label: z.string().trim().min(1).max(3),
  title: Text.max(200),
  description: Text,
  impactScope: Text,
  impactTime: Text,
  impactRisk: Text,
});
export type ChoiceDraft = z.infer<typeof ChoiceDraft>;

/** A Decision Request always has two to four Choices (or none for a plain-text Question). */
export const ChoiceDrafts = z.array(ChoiceDraft).min(2).max(4);

export const ChoiceView = ChoiceDraft.extend({
  id: Id,
  position: z.int().nonnegative(),
  editedByUser: z.boolean(),
});
export type ChoiceView = z.infer<typeof ChoiceView>;

// ─── Inputs ─────────────────────────────────────────────────────────────────

export const RaiseDecisionRequestInput = z.object({
  featureId: Id,
  kind: DecisionRequestKind,
  title: Text.max(200),
  description: Text,
  withChoices: z.boolean().default(true),
});
export type RaiseDecisionRequestInput = z.input<typeof RaiseDecisionRequestInput>;

/**
 * Who the Raiser sends the request to: every eligible holder of the decider role,
 * or one of them. Eligible means the Feature's Role Owners for that role or, when it
 * has none, the Team members holding it. The Raiser is never a recipient.
 */
export const Recipients = z.union([z.literal('ALL'), z.strictObject({ userId: Id })]);
export type Recipients = z.infer<typeof Recipients>;

export const SubmitDecisionRequestInput = z.object({
  deciderRole: TeamRole,
  recipients: Recipients.default('ALL'),
  choices: ChoiceDrafts.optional(),
  /**
   * A shorter Response Window than the Project's default for this kind (ADR 0011).
   * Never longer: a longer one is refused. Left out: the default.
   */
  responseWindow: ResponseWindow.optional(),
});
export type SubmitDecisionRequestInput = z.input<typeof SubmitDecisionRequestInput>;

/** Hand the request to someone else holding the decider role in the Team. */
export const ReassignInput = z.strictObject({ userId: Id });
export type ReassignInput = z.infer<typeof ReassignInput>;

/**
 * A message in a Decision Request's thread. The Decider asks a QUESTION (OPEN → NEEDS_INFO),
 * the Raiser gives an ANSWER (NEEDS_INFO → OPEN), and either may add a NOTE at any point
 * before a Decision.
 */
export const PostRequestMessageInput = z.strictObject({
  kind: RequestMessageKind,
  body: Text.max(10_000),
});
export type PostRequestMessageInput = z.infer<typeof PostRequestMessageInput>;

const Rationale = z.string().trim().min(1).optional();

/** Exactly one of `choiceId` or `customAnswer`. */
export const DecideInput = z.union([
  z.strictObject({ choiceId: Id, rationale: Rationale }),
  z.strictObject({ customAnswer: Text, rationale: Rationale }),
]);
export type DecideInput = z.infer<typeof DecideInput>;

export const ListDecisionRequestsQuery = z.object({
  decider: z.literal('me').optional(),
  raiser: z.literal('me').optional(),
  /** Requests sent to me that I can still Claim or decide: no Decider yet, or I am it. */
  recipient: z.literal('me').optional(),
  status: DecisionRequestStatus.optional(),
});
export type ListDecisionRequestsQuery = z.infer<typeof ListDecisionRequestsQuery>;

// ─── Views ──────────────────────────────────────────────────────────────────

export const PersonRef = z.object({ id: Id, name: z.string() });
export type PersonRef = z.infer<typeof PersonRef>;

export const DecisionView = z.object({
  id: Id,
  decidedBy: PersonRef,
  onBehalfOf: PersonRef.nullable(),
  choiceId: Id.nullable(),
  customAnswer: z.string().nullable(),
  rationale: z.string().nullable(),
  createdAt: Timestamp,
});
export type DecisionView = z.infer<typeof DecisionView>;

export const RequestMessageView = z.object({
  id: Id,
  kind: RequestMessageKind,
  author: PersonRef,
  body: z.string(),
  createdAt: Timestamp,
});
export type RequestMessageView = z.infer<typeof RequestMessageView>;

export const DecisionRequestView = z.object({
  id: Id,
  featureId: Id,
  featureTitle: z.string(),
  kind: DecisionRequestKind,
  status: DecisionRequestStatus,
  withChoices: z.boolean(),
  title: z.string(),
  description: z.string(),
  raiser: PersonRef,
  suggestedRole: TeamRole.nullable(),
  deciderRole: TeamRole,
  decider: PersonRef.nullable(),
  /** Who the request was sent to. Empty while DRAFT. */
  recipients: z.array(PersonRef),
  /**
   * Whether the viewer may Claim it now: it is OPEN, they hold the decider role in the
   * Team or are a recipient, and they are neither the Raiser nor already the Decider.
   */
  canClaim: z.boolean(),
  choices: z.array(ChoiceView),
  /** The ask-for-more-info thread between Decider and Raiser, oldest first. */
  messages: z.array(RequestMessageView),
  decision: DecisionView.nullable(),
  /** The Spec Proposal drafted from the Decision, if any. */
  specProposal: z.object({ id: Id, status: ProposalStatus }).nullable(),
  submittedAt: Timestamp.nullable(),
  /** Where it stands against its Response Window (ticket 0055). */
  responseWindow: ResponseWindowState,
  /** Its escalation steps, oldest first. */
  history: z.array(RequestHistoryEntryView),
  createdAt: Timestamp,
});
export type DecisionRequestView = z.infer<typeof DecisionRequestView>;
