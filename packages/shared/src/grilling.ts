import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import {
  GrillingRoundKind,
  GrillingRoundStatus,
  GrillingSkipReason,
  GrillingStatus,
  ProposalStatus,
  TeamRole,
} from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/**
 * The rounds of a Grilling in the order they are asked, and the Team Role whose
 * holders (in any of the Project's Teams) answer each one (REQUIREMENT §3.8).
 */
export const GRILLING_ROUNDS = [
  { kind: 'BUSINESS', role: 'PO' },
  { kind: 'UX', role: 'DESIGNER' },
  { kind: 'TECHNICAL', role: 'TECH_LEAD' },
] as const satisfies readonly { kind: GrillingRoundKind; role: TeamRole }[];

/** The most questions the AI may ask in one round. */
export const MAX_GRILLING_QUESTIONS = 7;

export const GrillingQuestionView = z.object({
  id: Id,
  position: z.int().nonnegative(),
  text: z.string(),
  answer: z.string().nullable(),
  answeredBy: PersonRef.nullable(),
  answeredAt: Timestamp.nullable(),
  /** Left unanswered because its round was skipped. */
  skipped: z.boolean(),
});
export type GrillingQuestionView = z.infer<typeof GrillingQuestionView>;

export const GrillingRoundView = z.object({
  kind: GrillingRoundKind,
  role: TeamRole,
  /** PENDING: not reached yet. */
  status: z.union([GrillingRoundStatus, z.literal('PENDING')]),
  skipReason: GrillingSkipReason.nullable(),
  questions: z.array(GrillingQuestionView),
});
export type GrillingRoundView = z.infer<typeof GrillingRoundView>;

/** A Grilling with all its rounds, in order, whether reached yet or not. */
export const GrillingView = z.object({
  id: Id,
  projectId: Id,
  status: GrillingStatus,
  startedBy: PersonRef,
  /** The round being asked while RUNNING; null otherwise. */
  currentRound: GrillingRoundKind.nullable(),
  rounds: z.array(GrillingRoundView),
  /** The Brief Proposal drafted from the answers, once DRAFTED. */
  proposal: z
    .object({
      id: Id,
      status: ProposalStatus,
      /** The Brief Version it became, once approved. */
      resultVersion: z.int().positive().nullable(),
    })
    .nullable(),
  /** Whether the viewer holds the current round's Team Role in one of the Project's Teams. */
  canAnswer: z.boolean(),
  /** Whether the viewer may skip the current round or cancel (the starter or an Admin). */
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type GrillingView = z.infer<typeof GrillingView>;

/** `POST /grillings/:id/questions/:questionId/answer`. */
export const AnswerGrillingQuestionInput = z.object({
  answer: z.string().trim().min(1, 'The answer is empty').max(10_000),
});
export type AnswerGrillingQuestionInput = z.infer<typeof AnswerGrillingQuestionInput>;

/** `POST /grillings/:id/skip-round`. `round` must be the current one, so a stale view can't skip the next. */
export const SkipGrillingRoundInput = z.object({ round: GrillingRoundKind });
export type SkipGrillingRoundInput = z.infer<typeof SkipGrillingRoundInput>;

/** `GET /grillings?awaiting=me`: the RUNNING Grillings whose current round waits for the viewer. */
export const ListGrillingsQuery = z.object({ awaiting: z.literal('me') });
export type ListGrillingsQuery = z.infer<typeof ListGrillingsQuery>;
