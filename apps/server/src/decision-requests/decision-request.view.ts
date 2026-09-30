import type { Prisma } from '@vorasaan/db';
import type { DecisionRequestView } from '@vorasaan/shared';

const person = { select: { id: true, name: true } } as const;

/** The `include` every Decision Request read uses, so `toView` always has what it needs. */
export const decisionRequestInclude = {
  feature: { select: { title: true } },
  raiser: person,
  decider: person,
  choices: { orderBy: { position: 'asc' } },
  decision: { include: { decidedBy: person, onBehalfOf: person } },
} satisfies Prisma.DecisionRequestInclude;

export type DecisionRequestWithRelations = Prisma.DecisionRequestGetPayload<{
  include: typeof decisionRequestInclude;
}>;

export function toDecisionRequestView(r: DecisionRequestWithRelations): DecisionRequestView {
  return {
    id: r.id,
    featureId: r.featureId,
    featureTitle: r.feature.title,
    kind: r.kind,
    status: r.status,
    withChoices: r.withChoices,
    title: r.title,
    description: r.description,
    raiser: r.raiser,
    suggestedRole: r.suggestedRole,
    deciderRole: r.deciderRole,
    decider: r.decider,
    choices: r.choices.map((c) => ({
      id: c.id,
      position: c.position,
      label: c.label,
      title: c.title,
      description: c.description,
      impactScope: c.impactScope,
      impactTime: c.impactTime,
      impactRisk: c.impactRisk,
      editedByUser: c.editedByUser,
    })),
    decision: r.decision && {
      id: r.decision.id,
      decidedBy: r.decision.decidedBy,
      onBehalfOf: r.decision.onBehalfOf,
      choiceId: r.decision.choiceId,
      customAnswer: r.decision.customAnswer,
      rationale: r.decision.rationale,
      createdAt: r.decision.createdAt.toISOString(),
    },
    submittedAt: r.submittedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
