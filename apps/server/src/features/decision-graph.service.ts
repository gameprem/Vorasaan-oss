import { Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  type DecisionGraphBranch,
  type DecisionGraphBranchState,
  type DecisionGraphNode,
  type DecisionGraphRedraft,
  type DecisionGraphView,
  type DecisionRequestStatus,
  type ProposalStatus,
  responseWindowLabels,
} from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { responseWindowState } from '../decision-requests/decision-request.view.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const person = { select: { id: true, name: true } } as const;

/** Where a sent request's branch stands, from its status and its Spec Proposal's. */
function branchState(
  status: DecisionRequestStatus,
  proposal: ProposalStatus | null,
): DecisionGraphBranchState {
  switch (status) {
    case 'NEEDS_INFO':
      return 'NEEDS_INFO';
    case 'WITHDRAWN':
      return 'WITHDRAWN';
    case 'SPEC_UPDATED':
      return 'MERGED';
    case 'DECIDED':
      return proposal === 'PENDING' ? 'AWAITING_APPROVAL' : 'CLOSED';
    default:
      return 'WAITING';
  }
}

/**
 * The Decision Graph of a Feature (ticket 0067), read from existing rows in a fixed number
 * of queries: the Feature (for access), its Spec Versions, its sent Decision Requests with
 * their Decision and Spec Proposal, and the Redrafts of both.
 */
@Injectable()
export class DecisionGraphService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async forFeature(user: User, featureId: string): Promise<DecisionGraphView> {
    // Everyone in the Feature's Organization reads it; anyone else learns nothing, not even
    // that it exists.
    const feature = await this.db.feature.findFirst({
      where: {
        id: featureId,
        team: { project: { organization: { memberships: { some: { userId: user.id } } } } },
      },
      select: { id: true },
    });
    if (!feature) throw new NotFoundException('Feature not found');

    const [versions, requests, redrafts] = await Promise.all([
      this.db.specVersion.findMany({
        where: { featureId },
        orderBy: { version: 'asc' },
        select: {
          id: true,
          version: true,
          source: true,
          summary: true,
          createdAt: true,
          revertedFromId: true,
          approvedBy: person,
        },
      }),
      this.db.decisionRequest.findMany({
        where: { featureId, submittedAt: { not: null }, status: { not: 'DRAFT' } },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          title: true,
          status: true,
          deciderRole: true,
          submittedAt: true,
          closedAt: true,
          dueAt: true,
          pausedAt: true,
          escalationStep: true,
          raiser: person,
          decider: person,
          decision: {
            select: {
              customAnswer: true,
              source: true,
              createdAt: true,
              decidedBy: person,
              onBehalfOf: person,
              choice: { select: { label: true, title: true } },
              specProposal: {
                select: {
                  id: true,
                  status: true,
                  reviewedAt: true,
                  resultVersion: { select: { version: true, createdAt: true } },
                },
              },
            },
          },
        },
      }),
      // Redraft 1 is the proposal as first drafted; only the later ones are marks.
      this.db.redraft.findMany({
        where: {
          number: { gte: 2 },
          OR: [
            { proposalKind: 'CHOICES', request: { featureId } },
            { proposalKind: 'SPEC_PROPOSAL', specProposal: { featureId } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
        select: {
          proposalKind: true,
          number: true,
          createdAt: true,
          requestId: true,
          specProposalId: true,
        },
      }),
    ]);

    // Related rows are matched here rather than joined, so the read stays a fixed few queries.
    const requestOfProposal = new Map<string, string>();
    const requestOfVersion = new Map<number, string>();
    for (const r of requests) {
      const proposal = r.decision?.specProposal;
      if (!proposal) continue;
      requestOfProposal.set(proposal.id, r.id);
      if (proposal.resultVersion) requestOfVersion.set(proposal.resultVersion.version, r.id);
    }
    const versionOfId = new Map(versions.map((v) => [v.id, v.version]));

    const marks = new Map<string, DecisionGraphRedraft[]>();
    for (const r of redrafts) {
      const requestId =
        r.requestId ?? (r.specProposalId ? requestOfProposal.get(r.specProposalId) : undefined);
      if (!requestId) continue; // a Spec Proposal drafted from Attachments or a Conversation
      const list = marks.get(requestId) ?? [];
      list.push({
        of: r.proposalKind === 'CHOICES' ? 'CHOICES' : 'SPEC_PROPOSAL',
        number: r.number,
        createdAt: r.createdAt.toISOString(),
      });
      marks.set(requestId, list);
    }

    const nodes: DecisionGraphNode[] = versions.map((v) => ({
      id: v.id,
      version: v.version,
      source: v.source,
      summary: v.summary,
      revertedFrom: v.revertedFromId ? (versionOfId.get(v.revertedFromId) ?? null) : null,
      approvedBy: v.approvedBy,
      createdAt: v.createdAt.toISOString(),
      requestId: requestOfVersion.get(v.version) ?? null,
    }));

    /** The Spec Version current at `at`: the last one created by then. */
    const currentAt = (at: Date) => {
      let current: number | null = null;
      for (const v of versions) {
        if (v.createdAt.getTime() > at.getTime()) break;
        current = v.version;
      }
      return current;
    };

    const now = this.clock.now();
    const branches = requests.flatMap((r): DecisionGraphBranch[] => {
      if (!r.submittedAt) return [];
      const proposal = r.decision?.specProposal ?? null;
      const state = branchState(r.status, proposal?.status ?? null);
      const merged = state === 'MERGED' ? (proposal?.resultVersion ?? null) : null;
      const waiting = state === 'WAITING' || state === 'NEEDS_INFO';
      const window = waiting ? responseWindowState(r) : null;
      let endedAt: Date | null = null;
      if (state === 'MERGED') endedAt = merged?.createdAt ?? r.closedAt;
      else if (state === 'CLOSED') endedAt = proposal?.reviewedAt ?? r.decision?.createdAt ?? null;
      else if (state === 'WITHDRAWN') endedAt = r.closedAt;
      const d = r.decision;
      return [
        {
          requestId: r.id,
          kind: r.kind,
          title: r.title,
          status: r.status,
          state,
          raiser: r.raiser,
          decider: r.decider,
          deciderRole: r.deciderRole,
          sentAt: r.submittedAt.toISOString(),
          endedAt: endedAt?.toISOString() ?? null,
          fromVersion: currentAt(r.submittedAt),
          toVersion: merged?.version ?? null,
          decision: d
            ? {
                decidedBy: d.decidedBy,
                onBehalfOf: d.onBehalfOf,
                choice: d.choice,
                customAnswer: d.customAnswer,
                source: d.source,
                createdAt: d.createdAt.toISOString(),
              }
            : null,
          specProposalId: proposal?.id ?? null,
          redrafts: marks.get(r.id) ?? [],
          responseWindow: window,
          labels: window ? responseWindowLabels(window, now) : [],
        },
      ];
    });

    return { featureId, nodes, branches };
  }
}
