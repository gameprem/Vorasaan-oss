import type { Prisma } from '@vorasaan/db';
import type { ActionCardDetail, ActionCardView } from '@vorasaan/shared';

export type ActionCardRow = Prisma.ActionCardGetPayload<object>;

export function toActionCardView(
  c: ActionCardRow,
  detail: ActionCardDetail | null,
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
  };
}
