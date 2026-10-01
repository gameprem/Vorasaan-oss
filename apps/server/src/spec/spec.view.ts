import type { Prisma } from '@vorasaan/db';
import type { SpecProposalView, SpecVersionView } from '@vorasaan/shared';
import { fromRecordedModelColumns } from '../ai/recorded-model.ts';

const person = { select: { id: true, name: true } } as const;
const draftedWith = {
  select: { approvedModelId: true, modelDisplayName: true, modelName: true },
} as const;

export const specVersionInclude = {
  approvedBy: person,
  revertedFrom: { select: { version: true } },
  proposal: draftedWith,
} satisfies Prisma.SpecVersionInclude;

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
    revertedFrom: v.revertedFrom?.version ?? null,
    draftedWith: fromRecordedModelColumns(v.proposal),
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
    draftedWith: fromRecordedModelColumns(p),
    createdAt: p.createdAt.toISOString(),
  };
}
