import type { Prisma } from '@vorasaan/db';
import type { BriefProposalView, BriefVersionView } from '@vorasaan/shared';
import { fromRecordedModelColumns } from '../ai/recorded-model.ts';

const person = { select: { id: true, name: true } } as const;
const draftedWith = {
  select: { approvedModelId: true, modelDisplayName: true, modelName: true },
} as const;

export const briefVersionInclude = {
  approvedBy: person,
  revertedFrom: { select: { version: true } },
  proposal: draftedWith,
} satisfies Prisma.BriefVersionInclude;

export type BriefVersionWithRelations = Prisma.BriefVersionGetPayload<{
  include: typeof briefVersionInclude;
}>;

export function toBriefVersionView(v: BriefVersionWithRelations): BriefVersionView {
  return {
    id: v.id,
    projectId: v.projectId,
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

export const briefProposalInclude = {
  approver: person,
  baseVersion: { select: { version: true, markdown: true } },
  resultVersion: { select: { version: true } },
} satisfies Prisma.BriefProposalInclude;

export type BriefProposalWithRelations = Prisma.BriefProposalGetPayload<{
  include: typeof briefProposalInclude;
}>;

export function toBriefProposalView(p: BriefProposalWithRelations): BriefProposalView {
  return {
    id: p.id,
    projectId: p.projectId,
    source: p.source,
    status: p.status,
    approver: p.approver,
    baseVersion: p.baseVersion?.version ?? null,
    baseMarkdown: p.baseVersion?.markdown ?? '',
    proposedMarkdown: p.proposedMarkdown,
    summary: p.summary,
    resultVersion: p.resultVersion?.version ?? null,
    draftedWith: fromRecordedModelColumns(p),
    createdAt: p.createdAt.toISOString(),
  };
}
