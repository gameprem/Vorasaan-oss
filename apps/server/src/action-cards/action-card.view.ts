import type { Prisma, PrismaClient } from '@vorasaan/db';
import type { ActionCardDetail, ActionCardView } from '@vorasaan/shared';

export type ActionCardRow = Prisma.ActionCardGetPayload<object>;

export function toActionCardView(
  c: ActionCardRow,
  detail: ActionCardDetail | null,
  redraft: ActionCardView['redraft'] = null,
): ActionCardView {
  return {
    id: c.id,
    conversationId: c.conversationId,
    messageId: c.messageId,
    kind: c.kind,
    targetId: c.targetId,
    status: c.status,
    title: c.title,
    summary: c.summary,
    createdAt: c.createdAt.toISOString(),
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    detail,
    redraft: detail ? redraft : null,
  };
}

/** What a Brief Proposal card proposes, as the proposal stands now; null once it is gone. */
export async function briefProposalDetail(
  db: Pick<PrismaClient, 'briefProposal'>,
  proposalId: string,
): Promise<ActionCardDetail | null> {
  const proposal = await db.briefProposal.findUnique({
    where: { id: proposalId },
    include: {
      approver: { select: { id: true, name: true } },
      baseVersion: { select: { version: true, markdown: true } },
      resultVersion: { select: { version: true } },
    },
  });
  if (!proposal) return null;
  return {
    kind: 'BRIEF_PROPOSAL',
    projectId: proposal.projectId,
    approver: proposal.approver,
    baseVersion: proposal.baseVersion?.version ?? null,
    baseMarkdown: proposal.baseVersion?.markdown ?? '',
    proposedMarkdown: proposal.proposedMarkdown,
    version: proposal.resultVersion?.version ?? null,
  };
}
