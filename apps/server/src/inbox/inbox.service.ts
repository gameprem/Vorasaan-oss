import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { InboxItem } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const person = { select: { id: true, name: true } } as const;
const feature = { select: { id: true, title: true } } as const;

/**
 * Inbox Items are derived from Decision Request and Spec Proposal state on every read
 * and never stored, so they disappear as soon as the state that caused them ends.
 */
@Injectable()
export class InboxService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async items(userId: string): Promise<InboxItem[]> {
    const [toDecide, toAnswer, toApprove] = await Promise.all([
      // DECIDE: I'm the Decider. CLAIM: nobody is, and it was sent to me — the same
      // requests as `GET /decision-requests?recipient=me`.
      this.db.decisionRequest.findMany({
        where: {
          status: 'OPEN',
          OR: [{ deciderId: userId }, { deciderId: null, recipients: { some: { userId } } }],
        },
        include: {
          feature,
          raiser: person,
          recipients: { where: { userId }, select: { onBehalfOf: person } },
        },
      }),
      this.db.decisionRequest.findMany({
        where: { status: 'NEEDS_INFO', raiserId: userId },
        include: {
          feature,
          decider: person,
          messages: {
            where: { kind: 'QUESTION' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { body: true, createdAt: true },
          },
        },
      }),
      this.db.specProposal.findMany({
        where: { status: 'PENDING', approverId: userId },
        include: {
          feature,
          decision: { select: { request: { select: { id: true, title: true, kind: true } } } },
        },
      }),
    ]);

    const items: InboxItem[] = [
      ...toDecide.map(
        (r): InboxItem => ({
          kind: r.deciderId === userId ? 'DECIDE' : 'CLAIM',
          feature: r.feature,
          since: r.updatedAt.toISOString(),
          decisionRequest: {
            id: r.id,
            title: r.title,
            kind: r.kind,
            raiser: r.raiser,
            deciderRole: r.deciderRole,
            onBehalfOf: r.recipients[0]?.onBehalfOf ?? null,
          },
        }),
      ),
      ...toAnswer.map((r): InboxItem => {
        const question = r.messages[0];
        return {
          kind: 'ANSWER',
          feature: r.feature,
          since: (question?.createdAt ?? r.updatedAt).toISOString(),
          decisionRequest: { id: r.id, title: r.title, kind: r.kind, decider: r.decider },
          question: question?.body ?? null,
        };
      }),
      ...toApprove.map(
        (p): InboxItem => ({
          kind: 'APPROVE_PROPOSAL',
          feature: p.feature,
          since: p.createdAt.toISOString(),
          specProposal: {
            id: p.id,
            source: p.source,
            decisionRequest: p.decision?.request ?? null,
          },
        }),
      ),
    ];
    return items.sort((a, b) => b.since.localeCompare(a.since));
  }
}
