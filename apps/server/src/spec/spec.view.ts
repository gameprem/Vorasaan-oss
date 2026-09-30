import type { Prisma } from '@vorasaan/db';
import type { SpecProposalView, SpecVersionView } from '@vorasaan/shared';

const person = { select: { id: true, name: true } } as const;

export const specVersionInclude = { approvedBy: person } satisfies Prisma.SpecVersionInclude;

export function toSpecVersionView(
  v: Prisma.SpecVersionGetPayload<{ include: typeof specVersionInclude }>,
): SpecVersionView {
  return {
    id: v.id,
    featureId: v.featureId,
    version: v.version,
    markdown: v.markdown,
    source: v.source,
    summary: v.summary,
    approvedBy: v.approvedBy,
    createdAt: v.createdAt.toISOString(),
  };
}

export const specProposalInclude = {
  approver: person,
  baseVersion: { select: { version: true, markdown: true } },
  decision: { select: { requestId: true } },
} satisfies Prisma.SpecProposalInclude;

export type SpecProposalWithRelations = Prisma.SpecProposalGetPayload<{
  include: typeof specProposalInclude;
}>;

export function toSpecProposalView(p: SpecProposalWithRelations): SpecProposalView {
  return {
    id: p.id,
    featureId: p.featureId,
    source: p.source,
    status: p.status,
    approver: p.approver,
    baseVersion: p.baseVersion?.version ?? null,
    baseMarkdown: p.baseVersion?.markdown ?? '',
    proposedMarkdown: p.proposedMarkdown,
    decisionRequestId: p.decision?.requestId ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}
