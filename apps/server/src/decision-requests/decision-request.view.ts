import type { Prisma } from '@vorasaan/db';
import type { DecisionRequestView, TeamRole } from '@vorasaan/shared';

const person = { select: { id: true, name: true } } as const;

/** The `include` every Decision Request read uses, so `toView` always has what it needs. */
export const decisionRequestInclude = {
  feature: { select: { title: true, teamId: true } },
  raiser: person,
  decider: person,
  recipients: { select: { user: person }, orderBy: { user: { name: 'asc' } } },
  choices: { orderBy: { position: 'asc' } },
  messages: { include: { author: person }, orderBy: { createdAt: 'asc' } },
  decision: {
    include: {
      decidedBy: person,
      onBehalfOf: person,
      specProposal: { select: { id: true, status: true } },
    },
  },
} satisfies Prisma.DecisionRequestInclude;

export type DecisionRequestWithRelations = Prisma.DecisionRequestGetPayload<{
  include: typeof decisionRequestInclude;
}>;

/** Who is looking, and the Team Roles they hold (`teamId:role`), for viewer-specific fields. */
export type Viewer = { userId: string; teamRoles: ReadonlySet<string> };

export const teamRoleKey = (teamId: string, role: TeamRole) => `${teamId}:${role}`;

/**
 * Who may ever Claim the request: anyone but the Raiser holding the decider role in the
 * Feature's Team, plus its recipients.
 */
export function isClaimant(r: DecisionRequestWithRelations, viewer: Viewer): boolean {
  if (r.raiserId === viewer.userId) return false;
  return (
    viewer.teamRoles.has(teamRoleKey(r.feature.teamId, r.deciderRole)) ||
    r.recipients.some((x) => x.user.id === viewer.userId)
  );
}

/** Whether the viewer can Claim it right now: OPEN, and not already its Decider. */
export function canClaim(r: DecisionRequestWithRelations, viewer: Viewer): boolean {
  return r.status === 'OPEN' && r.deciderId !== viewer.userId && isClaimant(r, viewer);
}

export function toDecisionRequestView(
  r: DecisionRequestWithRelations,
  viewer: Viewer,
): DecisionRequestView {
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
    recipients: r.recipients.map((x) => x.user),
    canClaim: canClaim(r, viewer),
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
    messages: r.messages.map((m) => ({
      id: m.id,
      kind: m.kind,
      author: m.author,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
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
    specProposal: r.decision?.specProposal ?? null,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
