// Moves a Decision Request's Response Window into the past, as if it had waited: its
// dueAt becomes `minutes` ago and its escalation reaches `step`. Runs under Bun, spawned by
// a spec, against the end-to-end database. Usage: bun age-request.ts <id> <minutes> <step>

import { createPrismaClient } from '@vorasaan/db';

const [id, minutes, step] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_e2e')) {
  throw new Error('DATABASE_URL must be the end-to-end database (its name ends in _e2e)');
}
if (!id || !minutes || !step) throw new Error('Usage: bun age-request.ts <id> <minutes> <step>');

const db = createPrismaClient(url);
try {
  await db.decisionRequest.update({
    where: { id },
    data: {
      dueAt: new Date(Date.now() - Number(minutes) * 60_000),
      escalationStep: Number(step),
    },
  });
} finally {
  await db.$disconnect();
}
