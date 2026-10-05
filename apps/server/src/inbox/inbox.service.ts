import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type {
  DecisionRequestKind,
  DecisionRequestRef,
  FeatureRef,
  InboxItem,
  PersonRef,
  SpecVersionSource,
  TeamRole,
} from '@vorasaan/shared';
import { responseWindowState } from '../decision-requests/decision-request.view.ts';
import { awaitingGrillingsWhere } from '../grilling/awaiting.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const person = { select: { id: true, name: true } } as const;
const feature = { select: { id: true, title: true } } as const;
const project = { select: { id: true, name: true } } as const;

/**
 * Inbox Items are derived from Decision Request, Spec Proposal, Brief Proposal and Grilling
 * state on every read and never stored, so they disappear as soon as the state that
 * caused them ends.
 */
@Injectable()
export class InboxService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async items(userId: string): Promise<InboxItem[]> {
    const grillingsWhere = await awaitingGrillingsWhere(this.db, userId);
    const [toDecide, toAnswer, toApprove, toGrill, briefsToApprove] = await Promise.all([
      this.requestsToDecide(userId),
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
      this.proposalsToApprove(userId),
      // Grilling questions waiting for a Team Role I hold (same as `GET /grillings?awaiting=me`).
      grillingsWhere
        ? this.db.grilling.findMany({
            where: grillingsWhere,
            include: {
              project,
              rounds: {
                where: { status: 'ASKING' },
                select: {
                  id: true,
                  kind: true,
                  role: true,
                  createdAt: true,
                  _count: { select: { questions: { where: { answeredAt: null } } } },
                },
              },
            },
          })
        : [],
      this.db.briefProposal.findMany({
        where: { status: 'PENDING', approverId: userId },
        include: { project },
      }),
    ]);

    // My Grilling Conversation for each round asked of me (ticket 0044).
    const grillingConversations = toGrill.length
      ? await this.db.conversation.findMany({
          where: {
            ownerId: userId,
            grillingRoundId: { in: toGrill.flatMap((g) => g.rounds.map((r) => r.id)) },
          },
          select: { id: true, grillingRoundId: true },
        })
      : [];
    const conversationOf = new Map(grillingConversations.map((t) => [t.grillingRoundId, t.id]));

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
            onBehalfOf: r.onBehalfOf,
            responseWindow: responseWindowState(r),
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
            decisionRequest: p.decisionRequest,
          },
        }),
      ),
      ...toGrill.flatMap((g): InboxItem[] => {
        const round = g.rounds[0];
        if (!round || round._count.questions === 0) return [];
        return [
          {
            kind: 'ANSWER_GRILLING',
            project: g.project,
            since: round.createdAt.toISOString(),
            grilling: {
              id: g.id,
              round: round.kind,
              role: round.role,
              unanswered: round._count.questions,
              conversationId: conversationOf.get(round.id) ?? null,
            },
          },
        ];
      }),
      ...briefsToApprove.map(
        (p): InboxItem => ({
          kind: 'APPROVE_BRIEF_PROPOSAL',
          project: p.project,
          since: p.createdAt.toISOString(),
          briefProposal: { id: p.id, source: p.source },
        }),
      ),
    ];
    return items.sort((a, b) => b.since.localeCompare(a.since));
  }

  /**
   * DECIDE: I'm the Decider. CLAIM: nobody is, and it was sent to me — the same requests
   * as `GET /decision-requests?recipient=me`. One statement with what the item shows
   * (ticket 0074): a heavy Inbox has well over a thousand of them.
   */
  private requestsToDecide(userId: string) {
    return this.db.$queryRaw<RequestToDecideRow[]>`
      SELECT d.id, d.title, d.kind::text AS kind, d."deciderId", d."deciderRole"::text AS "deciderRole",
             d."updatedAt", d."dueAt", d."pausedAt", d."escalationStep",
             json_build_object('id', f.id, 'title', f.title) AS feature,
             json_build_object('id', raiser.id, 'name', raiser.name) AS raiser,
             CASE WHEN behalf.id IS NULL THEN NULL
                  ELSE json_build_object('id', behalf.id, 'name', behalf.name) END AS "onBehalfOf"
      FROM "DecisionRequest" d
      JOIN "Feature" f ON f.id = d."featureId"
      JOIN "User" raiser ON raiser.id = d."raiserId"
      LEFT JOIN "RequestRecipient" me ON me."requestId" = d.id AND me."userId" = ${userId}
      LEFT JOIN "User" behalf ON behalf.id = me."onBehalfOfId"
      WHERE d.status = 'OPEN'
        AND (d."deciderId" = ${userId} OR (d."deciderId" IS NULL AND me.id IS NOT NULL))`;
  }

  /** PENDING Spec Proposals I approve, with their Feature and Decision Request, in one statement. */
  private proposalsToApprove(userId: string) {
    return this.db.$queryRaw<ProposalToApproveRow[]>`
      SELECT p.id, p.source::text AS source, p."createdAt",
             json_build_object('id', f.id, 'title', f.title) AS feature,
             CASE WHEN r.id IS NULL THEN NULL
                  ELSE json_build_object('id', r.id, 'title', r.title, 'kind', r.kind) END
               AS "decisionRequest"
      FROM "SpecProposal" p
      JOIN "Feature" f ON f.id = p."featureId"
      LEFT JOIN "Decision" dn ON dn.id = p."decisionId"
      LEFT JOIN "DecisionRequest" r ON r.id = dn."requestId"
      WHERE p.status = 'PENDING' AND p."approverId" = ${userId}`;
  }
}

type RequestToDecideRow = {
  id: string;
  title: string;
  kind: DecisionRequestKind;
  deciderId: string | null;
  deciderRole: TeamRole;
  updatedAt: Date;
  dueAt: Date | null;
  pausedAt: Date | null;
  escalationStep: number;
  feature: FeatureRef;
  raiser: PersonRef;
  onBehalfOf: PersonRef | null;
};

type ProposalToApproveRow = {
  id: string;
  source: SpecVersionSource;
  createdAt: Date;
  feature: FeatureRef;
  decisionRequest: DecisionRequestRef | null;
};
