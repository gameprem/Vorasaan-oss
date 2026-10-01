import type { Prisma } from '@vorasaan/db';
import { GRILLING_ROUNDS, GrillingFollowUp, type GrillingView } from '@vorasaan/shared';
import { z } from 'zod';

const person = { select: { id: true, name: true } } as const;

export const grillingInclude = {
  startedBy: person,
  rounds: {
    include: {
      questions: { orderBy: { position: 'asc' }, include: { answeredBy: person } },
    },
  },
  proposal: { select: { id: true, status: true, resultVersion: { select: { version: true } } } },
} satisfies Prisma.GrillingInclude;

export type GrillingWithRelations = Prisma.GrillingGetPayload<{ include: typeof grillingInclude }>;
export type GrillingRoundWithQuestions = GrillingWithRelations['rounds'][number];

const StoredFollowUps = z.array(GrillingFollowUp);

/** A question's stored follow-ups (ticket 0044); none when unset or unreadable. */
export function followUpsOf(value: Prisma.JsonValue | null): GrillingFollowUp[] {
  if (value === null) return [];
  const parsed = StoredFollowUps.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** What the viewer may do, worked out by the service. */
export type GrillingPermissions = { canAnswer: boolean; canManage: boolean };

/** Every round in order; one not reached yet is PENDING with no questions. */
export function toGrillingView(g: GrillingWithRelations, can: GrillingPermissions): GrillingView {
  const byKind = new Map(g.rounds.map((r) => [r.kind, r]));
  return {
    id: g.id,
    projectId: g.projectId,
    status: g.status,
    startedBy: g.startedBy,
    currentRound: g.currentRound,
    rounds: GRILLING_ROUNDS.map(({ kind, role }) => {
      const round = byKind.get(kind);
      if (!round) return { kind, role, status: 'PENDING', skipReason: null, questions: [] };
      return {
        kind,
        role: round.role,
        status: round.status,
        skipReason: round.skipReason,
        questions: round.questions.map((q) => ({
          id: q.id,
          position: q.position,
          text: q.text,
          answer: q.answer,
          answeredBy: q.answeredBy,
          answeredAt: q.answeredAt?.toISOString() ?? null,
          followUps: followUpsOf(q.followUps),
          skipped: q.skipped,
        })),
      };
    }),
    proposal: g.proposal && {
      id: g.proposal.id,
      status: g.proposal.status,
      resultVersion: g.proposal.resultVersion?.version ?? null,
    },
    canAnswer: can.canAnswer,
    canManage: can.canManage,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}
