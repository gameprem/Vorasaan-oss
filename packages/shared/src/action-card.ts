import { z } from 'zod';
import { ChoiceDrafts, Recipients } from './decision-request.ts';
import { ActionCardKind, ActionCardStatus, TeamRole } from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

// ─── Action Cards (ADR 0008, ticket 0043) ───────────────────────────────────
// What the AI proposes in a Conversation. Only the Conversation's owner sees and
// acts on them; approving or declining calls the target's own service.

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
  })
  .optional();
export type ApproveActionCardInput = z.infer<typeof ApproveActionCardInput>;

/**
 * `POST /action-cards/:id/decline`. The body is optional; `reason` is a Feature
 * Suggestion's dismiss reason, which the AI reads next time.
 */
export const DeclineActionCardInput = z
  .strictObject({ reason: z.string().trim().min(1).max(1000).optional() })
  .optional();
export type DeclineActionCardInput = z.infer<typeof DeclineActionCardInput>;

/** An Action Card was made, or its status changed. Sent to the Conversation's owner only. */
export const ActionCardEvent = z.object({ conversationId: Id, card: ActionCardView });
export type ActionCardEvent = z.infer<typeof ActionCardEvent>;
