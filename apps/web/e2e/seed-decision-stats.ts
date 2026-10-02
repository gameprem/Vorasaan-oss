// Seeds a Project of its own with Decision Requests that already ran their course, for the
// Decision Lead Time panel (ticket 0056): three decided last week with lead times of 1h, 2h
// and 4h (median 2h), and two OPEN ones past their Response Window. Times are on a weekday
// 10:00 UTC, inside the default working hours. Runs under Bun, spawned by a spec, against
// the end-to-end database; prints the Project's id. Usage: bun seed-decision-stats.ts <name>

import { createPrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';

const [name] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_e2e')) {
  throw new Error('DATABASE_URL must be the end-to-end database (its name ends in _e2e)');
}
if (!name) throw new Error('Usage: bun seed-decision-stats.ts <project name>');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const { pim, beam } = SEED.users;

// Tuesday of last week, 10:00 UTC.
const now = new Date();
const monday =
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
  ((now.getUTCDay() + 6) % 7) * DAY;
const sent = new Date(monday - 7 * DAY + DAY + 10 * HOUR);

const db = createPrismaClient(url);
try {
  const project = await db.project.create({
    data: { organizationId: SEED.organizationId, name },
  });
  const team = await db.team.create({ data: { projectId: project.id, name: 'Payments' } });
  const feature = await db.feature.create({
    data: { teamId: team.id, title: 'Instant refunds' },
  });

  const base = {
    featureId: feature.id,
    raiserId: beam.id,
    description: 'Seeded for the Decision Lead Time panel.',
    deciderRole: 'PO' as const,
    submittedAt: sent,
    responseWindowMinutes: 240,
    recipients: { create: [{ userId: pim.id }] },
  };
  for (const [i, hours] of [1, 2, 4].entries()) {
    const request = await db.decisionRequest.create({
      data: {
        ...base,
        kind: i === 0 ? 'QUESTION' : 'BLOCKER',
        title: `Decided in ${hours}h`,
        status: 'DECIDED',
        deciderId: pim.id,
        dueAt: new Date(sent.getTime() + 4 * HOUR),
      },
    });
    await db.decision.create({
      data: {
        requestId: request.id,
        decidedById: pim.id,
        customAnswer: 'Go ahead.',
        createdAt: new Date(sent.getTime() + hours * HOUR),
      },
    });
  }
  for (const title of ['Overdue: refund limit', 'Overdue: refund currency']) {
    await db.decisionRequest.create({
      data: {
        ...base,
        kind: 'BLOCKER',
        title,
        status: 'OPEN',
        deciderId: pim.id,
        dueAt: new Date(sent.getTime() + 4 * HOUR),
      },
    });
  }
  process.stdout.write(project.id);
} finally {
  await db.$disconnect();
}
