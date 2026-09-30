import type { Prisma } from '@vorasaan/db';
import type { FeatureSuggestionView } from '@vorasaan/shared';

const person = { select: { id: true, name: true } } as const;

export const featureSuggestionInclude = {
  generatedBy: person,
  decidedBy: person,
} satisfies Prisma.FeatureSuggestionInclude;

export type FeatureSuggestionWithRelations = Prisma.FeatureSuggestionGetPayload<{
  include: typeof featureSuggestionInclude;
}>;

export function toFeatureSuggestionView(s: FeatureSuggestionWithRelations): FeatureSuggestionView {
  return {
    id: s.id,
    projectId: s.projectId,
    batchId: s.batchId,
    title: s.title,
    rationale: s.rationale,
    businessValue: s.businessValue,
    effort: s.effort,
    risk: s.risk,
    servesGuidelineIds: s.servesGuidelineIds,
    status: s.status,
    dismissReason: s.dismissReason,
    decidedBy: s.decidedBy,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    featureId: s.featureId,
    generatedBy: s.generatedBy,
    createdAt: s.createdAt.toISOString(),
  };
}
