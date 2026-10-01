// Empties the end-to-end database and seeds the full Checkout Team, so every run starts from
// the same world. Runs under Bun (the seed hashes passwords with Bun.password), spawned by
// global-setup.ts. The schema must already be migrated (`bun run db:deploy` in packages/db).

import { createPrismaClient } from '@vorasaan/db';
import { seed, seedFullTeam } from '@vorasaan/db/seed';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const name = new URL(url).pathname.slice(1);
if (!name.endsWith('_e2e')) {
  throw new Error(`Refusing to reset "${name}": the end-to-end database name must end in _e2e`);
}

const db = createPrismaClient(url);
try {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) {
    throw new Error(`"${name}" has no tables. Migrate it first: bun run db:deploy in packages/db`);
  }
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await seed(db);
  await seedFullTeam(db);
} finally {
  await db.$disconnect();
}
