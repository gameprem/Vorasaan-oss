import { z } from 'zod';
import { GrillingRoundKind, TeamRole } from './enums.ts';

// ─── What the server writes in a Grilling Conversation (tickets 0044, 0047) ──
// The server composes the questions, acknowledgements and notices of a Grilling
// Conversation itself; only the follow-up questions come from the AI. Each such
// message is stored as Grilling Notes: the facts it states, so a client can show
// them in the reader's language (Thai or English) and tell a quiet notice from
// the AI's voice. Its `content` is the same notes in English, for every client
// that reads only text.

/**
 * One piece of what the server wrote in a Grilling Conversation:
 * - INTRO: the round's introduction, when the Conversation is opened;
 * - ASK: a question of the round (`position` from 0; `text` is the AI-written question);
 * - FOLLOW_UP: a follow-up the AI asked (`number` from 1; `text` is the AI's own words);
 * - RECORDED / SKIPPED: the owner's answer was recorded, or they skipped the question;
 * - ANSWERED_ELSEWHERE: someone else answered the question being asked here;
 * - WAITING: nothing left to ask the owner for now;
 * - CLOSED: the round is over (complete, skipped, or the Grilling was cancelled);
 * - BRIEF_DRAFTED: the Grilling is done and its Brief Proposal waits for the starter,
 *   as the Action Card under the message.
 */
export const GrillingNote = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('INTRO'),
    round: GrillingRoundKind,
    role: TeamRole,
    total: z.int().nonnegative(),
    answered: z.int().nonnegative(),
    maxFollowUps: z.int().nonnegative(),
  }),
  z.object({
    kind: z.literal('ASK'),
    position: z.int().nonnegative(),
    total: z.int().nonnegative(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('FOLLOW_UP'), number: z.int().positive(), text: z.string() }),
  z.object({ kind: z.literal('RECORDED'), position: z.int().nonnegative() }),
  z.object({ kind: z.literal('SKIPPED'), position: z.int().nonnegative() }),
  z.object({
    kind: z.literal('ANSWERED_ELSEWHERE'),
    position: z.int().nonnegative(),
    by: z.string(),
    answer: z.string(),
    /** The owner had started replying to it, and that reply wasn't recorded. */
    hadReply: z.boolean(),
  }),
  z.object({ kind: z.literal('WAITING'), role: TeamRole, open: z.int().nonnegative() }),
  z.object({
    kind: z.literal('CLOSED'),
    round: GrillingRoundKind,
    reason: z.enum(['COMPLETE', 'ROUND_SKIPPED', 'CANCELLED']),
  }),
  z.object({ kind: z.literal('BRIEF_DRAFTED'), project: z.string() }),
]);
export type GrillingNote = z.infer<typeof GrillingNote>;
