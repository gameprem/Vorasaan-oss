import { z } from 'zod';
import { DecisionRequestKind, DecisionRequestStatus, TeamRole } from './enums.ts';

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

export const SubmitDecisionRequestInput = z.object({
  deciderRole: TeamRole,
  choices: ChoiceDrafts.optional(),
});
export type SubmitDecisionRequestInput = z.infer<typeof SubmitDecisionRequestInput>;

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
  choices: z.array(ChoiceView),
  decision: DecisionView.nullable(),
  submittedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type DecisionRequestView = z.infer<typeof DecisionRequestView>;
