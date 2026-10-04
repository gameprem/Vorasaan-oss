import { z } from 'zod';
import { ChoiceDraft, ChoiceDrafts, PersonRef, Recipients } from './decision-request.ts';
import {
  ActionCardKind,
  ActionCardStatus,
  DecisionRequestKind,
  SuggestionLevel,
  TeamRole,
} from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

// ─── Action Cards (ADR 0008, ticket 0043) ───────────────────────────────────
// What the AI proposes in a Conversation. Only the Conversation's owner sees and
// acts on them; approving or declining calls the target's own service.

/**
 * What a card proposes, read from its target when the card is shown (ticket
 * 0046), so a client draws the card without fetching the target:
 * - DECISION_REQUEST: the draft, the Team Role it goes to on Send and who
 *   would receive it as that role (the Feature's Role Owners, else the Team's
 *   holders; never the Raiser);
 * - SPEC_PROPOSAL / BRIEF_PROPOSAL: both sides of the change, its approver
 *   (only they approve or reject it) and, once approved, the version it wrote;
 * - FEATURE_SUGGESTION: the suggestion, and the Feature once accepted.
 */
export const ActionCardDetail = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('DECISION_REQUEST'),
    requestKind: DecisionRequestKind,
    description: z.string(),
    deciderRole: TeamRole,
    recipients: z.array(PersonRef),
    /** Empty for a plain-text Question. */
    choices: z.array(ChoiceDraft),
  }),
  z.object({
    kind: z.literal('SPEC_PROPOSAL'),
    featureId: Id,
    approver: PersonRef,
    /** The Spec Version it was drafted against; null for a Feature's first Spec. */
    baseVersion: z.int().positive().nullable(),
    baseMarkdown: z.string(),
    proposedMarkdown: z.string(),
    /** The Spec Version approving it wrote. */
    version: z.int().positive().nullable(),
  }),
  z.object({
    kind: z.literal('BRIEF_PROPOSAL'),
    projectId: Id,
    approver: PersonRef,
    /** The Brief Version it was drafted against; null for a Project's first Brief. */
    baseVersion: z.int().positive().nullable(),
    baseMarkdown: z.string(),
    proposedMarkdown: z.string(),
    /** The Brief Version approving it wrote. */
    version: z.int().positive().nullable(),
  }),
  z.object({
    kind: z.literal('FEATURE_SUGGESTION'),
    rationale: z.string(),
    businessValue: z.string(),
    effort: SuggestionLevel,
    risk: SuggestionLevel,
    dismissReason: z.string().nullable(),
    /** The Feature made when it was accepted. */
    featureId: Id.nullable(),
  }),
]);
export type ActionCardDetail = z.infer<typeof ActionCardDetail>;

/**
 * A proposal the AI made in a Conversation, and its target: a DRAFT Decision
 * Request, a PENDING Spec Proposal or Brief Proposal, or a PENDING Feature
 * Suggestion. STALE means the target changed elsewhere (sent, approved,
 * rejected, or its Spec or Brief moved on), so the card can no longer be acted on.
 */
export const ActionCardView = z.object({
  id: Id,
  conversationId: Id,
  /** The ASSISTANT message whose tool call made it. */
  messageId: Id,
  kind: ActionCardKind,
  /** The Decision Request, Spec Proposal, Brief Proposal or Feature Suggestion. */
  targetId: Id,
  status: ActionCardStatus,
  title: z.string(),
  /** What the AI says it changes, when it said. */
  summary: z.string().nullable(),
  createdAt: Timestamp,
  /** When it was approved, declined or found STALE. */
  reviewedAt: Timestamp.nullable(),
  /** What it proposes, as its target stands now; null once the target is gone. */
  detail: ActionCardDetail.nullable(),
  /**
   * Its Redrafts (ticket 0065): `current` is the one shown and the one Approve applies
   * (1 until someone Requests changes), `writing` while the AI writes the next one, and
   * how many Request changes are `left`. Null once the target is gone.
   */
  redraft: z
    .object({
      current: z.int().positive(),
      writing: z.boolean(),
      left: z.int().nonnegative(),
      /** The feedback that caused the current Redraft; null for Redraft 1. */
      feedback: z.string().nullable(),
    })
    .nullable(),
});
export type ActionCardView = z.infer<typeof ActionCardView>;

/**
 * `POST /action-cards/:id/approve`. The body is optional:
 * - a Decision Request card sends the draft to `deciderRole` (default: the role
 *   the AI suggested) and `recipients` (default: all eligible), with `choices`
 *   if the person edited them;
 * - a Feature Suggestion card accepts it into `teamId` (default: the Project's
 *   only Team, or the only one of its Teams where the person is PO).
 */
export const ApproveActionCardInput = z
  .strictObject({
    deciderRole: TeamRole.optional(),
    recipients: Recipients.optional(),
    choices: ChoiceDrafts.optional(),
    teamId: Id.optional(),
    /**
     * The Redraft the person saw and approves (ticket 0065). When another one is current
     * by now, nothing is approved (409).
     */
    redraft: z.int().positive().optional(),
  })
  .optional();
export type ApproveActionCardInput = z.infer<typeof ApproveActionCardInput>;

/**
 * `POST /action-cards/:id/decline`. The body is optional; `reason` is kept with the
 * proposal's Receipt (ticket 0070), and for a Feature Suggestion it is also the dismiss
 * reason the AI reads next time.
 */
export const DeclineActionCardInput = z
  .strictObject({ reason: z.string().trim().min(1).max(1000).optional() })
  .optional();
export type DeclineActionCardInput = z.infer<typeof DeclineActionCardInput>;

/** An Action Card was made, or its status changed. Sent to the Conversation's owner only. */
export const ActionCardEvent = z.object({ conversationId: Id, card: ActionCardView });
export type ActionCardEvent = z.infer<typeof ActionCardEvent>;
