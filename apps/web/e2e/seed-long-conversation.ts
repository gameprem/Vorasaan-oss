// Stores a long Conversation straight in the end-to-end database: Pim's, about the seeded
// Feature, `count` messages ("History message 0", 1, 2…), the person and the AI in turn,
// a second apart. Prints its id. Runs under Bun, spawned by a spec.
// Usage: bun seed-long-conversation.ts <count> <title>

import { createPrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';

const [count, title] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_e2e')) {
  throw new Error('DATABASE_URL must be the end-to-end database (its name ends in _e2e)');
}
if (!count || !title) throw new Error('Usage: bun seed-long-conversation.ts <count> <title>');

const n = Number(count);
const db = createPrismaClient(url);
try {
  const start = Date.now() - n * 1_000 - 60_000;
  const conversation = await db.conversation.create({
    data: {
      ownerId: SEED.users.pim.id,
      projectId: SEED.projectId,
      featureId: SEED.featureId,
      title,
    },
  });
  await db.conversationMessage.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      conversationId: conversation.id,
      position: i,
      role: i % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
      content:
        i % 2 === 0
          ? `History message ${i}: a question about the checkout.`
          : `History message ${i}: an answer about the checkout, long enough to wrap onto a second line in the chat column, so the pages have some height.`,
      createdAt: new Date(start + i * 1_000),
    })),
  });
  process.stdout.write(conversation.id);
} finally {
  await db.$disconnect();
}
