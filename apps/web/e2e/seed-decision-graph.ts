// Seeds a Feature of its own in the seeded Checkout Team for the Decision Graph (ticket 0067):
//   v1 by hand ── a Blocker decided in Slack, redrafted once, merged as v2 ── v3 by hand
//   ── a Question decided without a Spec change ── v4 reverts to v1 ── then three open
//   requests: a Blocker waiting for its Decider, a Question in NEEDS_INFO, and a Question
//   whose Spec Proposal awaits approval.
// With "empty" it seeds a Feature with a Spec and no requests. Runs under Bun, spawned by a
// spec, against the end-to-end database; prints the Feature's id.
// Usage: bun seed-decision-graph.ts <title> [empty]

import { createPrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';

const [title, mode] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_e2e')) {
  throw new Error('DATABASE_URL must be the end-to-end database (its name ends in _e2e)');
}
if (!title) throw new Error('Usage: bun seed-decision-graph.ts <title> [empty]');

const HOUR = 60 * 60 * 1000;
const { pim, beam } = SEED.users;
const now = Date.now();
const t0 = now - 3 * 24 * HOUR;
const at = (hours: number) => new Date(t0 + hours * HOUR);

const db = createPrismaClient(url);
try {
  const feature = await db.feature.create({
    data: {
      teamId: SEED.teamId,
      title,
      status: 'IN_PROGRESS',
      roleOwners: {
        create: [
          { userId: pim.id, role: 'PO' },
          { userId: beam.id, role: 'BACKEND' },
        ],
      },
    },
  });
  const featureId = feature.id;
  const version = (n: number, hours: number, extra: object = {}) =>
    db.specVersion.create({
      data: {
        featureId,
        version: n,
        markdown: `# ${title}\n\nSpec v${n}.\n`,
        source: 'MANUAL',
        summary: n === 1 ? 'Initial Spec' : 'Edited by hand',
        approvedById: pim.id,
        createdAt: at(hours),
        ...extra,
      },
    });
  const v1 = await version(1, 0);

  if (mode !== 'empty') {
    const base = {
      featureId,
      raiserId: beam.id,
      description: 'Seeded for the Decision Graph.',
      deciderRole: 'PO' as const,
      deciderId: pim.id,
      responseWindowMinutes: 240,
      recipients: { create: [{ userId: pim.id }] },
    };
    const choices = {
      create: ['A', 'B'].map((label, position) => ({
        position,
        label,
        title: label === 'A' ? 'Poll every minute' : 'Wait for the webhook',
        description: 'Seeded.',
        impactScope: 'Checkout',
        impactTime: '1 day',
        impactRisk: 'Low',
      })),
    };

    /** A sent request decided at `decidedAt`, with its Spec Proposal on `baseVersionId`. */
    async function decided(
      data: { title: string; kind: 'BLOCKER' | 'QUESTION'; status: 'DECIDED' | 'SPEC_UPDATED' },
      sent: number,
      decidedAt: number,
      decision: { choice?: string; customAnswer?: string; source: 'WEB' | 'SLACK' },
      proposal: { baseVersionId: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' },
    ) {
      const request = await db.decisionRequest.create({
        data: { ...base, ...data, submittedAt: at(sent), choices, dueAt: at(sent + 4) },
        include: { choices: true },
      });
      const made = await db.decision.create({
        data: {
          requestId: request.id,
          decidedById: pim.id,
          choiceId: request.choices.find((c) => c.label === decision.choice)?.id ?? null,
          customAnswer: decision.customAnswer ?? null,
          source: decision.source,
          createdAt: at(decidedAt),
        },
      });
      const specProposal = await db.specProposal.create({
        data: {
          featureId,
          baseVersionId: proposal.baseVersionId,
          source: 'DECISION',
          proposedMarkdown: `# ${title}\n\nAfter "${data.title}".\n`,
          status: proposal.status,
          approverId: pim.id,
          decisionId: made.id,
          reviewedAt: proposal.status === 'PENDING' ? null : at(decidedAt + 1),
          createdAt: at(decidedAt),
        },
      });
      return { request, specProposal };
    }

    const webhook = await decided(
      { title: 'Webhook or polling?', kind: 'BLOCKER', status: 'SPEC_UPDATED' },
      1,
      2,
      { choice: 'B', source: 'SLACK' },
      { baseVersionId: v1.id, status: 'APPROVED' },
    );
    // Request changes once on its Spec Proposal: Redraft 1 kept, Redraft 2 approved.
    for (const number of [1, 2]) {
      await db.redraft.create({
        data: {
          proposalKind: 'SPEC_PROPOSAL',
          proposalId: webhook.specProposal.id,
          specProposalId: webhook.specProposal.id,
          number,
          content: { kind: 'MARKDOWN', markdown: `Redraft ${number}` },
          feedback: number === 1 ? null : 'Name the provider.',
          createdAt: at(2 + number * 0.3),
          readyAt: at(2 + number * 0.3),
        },
      });
    }
    await version(2, 3, {
      source: 'DECISION',
      summary: 'Wait for the webhook',
      proposalId: webhook.specProposal.id,
    });
    await db.decisionRequest.update({
      where: { id: webhook.request.id },
      data: { closedAt: at(3) },
    });
    const v3 = await version(3, 4);

    await decided(
      { title: 'Keep the old receipt?', kind: 'QUESTION', status: 'DECIDED' },
      5,
      6,
      { customAnswer: 'Keep it for now', source: 'WEB' },
      { baseVersionId: v3.id, status: 'REJECTED' },
    );
    const v4 = await version(4, 8, {
      source: 'REVERT',
      summary: 'Reverted to v1',
      revertedFromId: v1.id,
    });

    // Open: waiting for its Decider, due 3 hours from now.
    await db.decisionRequest.create({
      data: {
        ...base,
        title: 'Which retry budget?',
        kind: 'BLOCKER',
        status: 'OPEN',
        submittedAt: at(9),
        dueAt: new Date(now + 3 * HOUR),
        choices,
      },
    });
    // Open: the Decider asked the Raiser; its clock is paused.
    const asked = await db.decisionRequest.create({
      data: {
        ...base,
        title: 'Refund limit?',
        kind: 'QUESTION',
        withChoices: false,
        status: 'NEEDS_INFO',
        submittedAt: at(10),
        dueAt: at(14),
        pausedAt: at(11),
      },
    });
    await db.requestMessage.create({
      data: {
        requestId: asked.id,
        authorId: pim.id,
        kind: 'QUESTION',
        body: 'Up to which amount?',
        createdAt: at(11),
      },
    });
    // Open: decided, its Spec Proposal awaits Pim's approval.
    await decided(
      { title: 'Show the fee?', kind: 'QUESTION', status: 'DECIDED' },
      12,
      13,
      { choice: 'A', source: 'WEB' },
      { baseVersionId: v4.id, status: 'PENDING' },
    );
  }

  console.log(featureId);
} finally {
  await db.$disconnect();
}
