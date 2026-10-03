// An empty, migrated database for setup.e2e.ts (ticket 0063): creates it if needed, applies
// the migrations, and empties every table, so the server it starts needs first-run setup.
// Runs under Bun, spawned by the spec, before that server starts.

import { createPrismaClient } from '@vorasaan/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const name = new URL(url).pathname.slice(1);
if (!name.endsWith('_e2e')) {
  throw new Error(`Refusing to empty "${name}": the end-to-end database name must end in _e2e`);
}

const admin = new URL(url);
admin.pathname = '/postgres';
const server = createPrismaClient(admin.toString());
try {
  const found = await server.$queryRaw<
    unknown[]
  >`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (found.length === 0) await server.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
} finally {
  await server.$disconnect();
}

const migrate = Bun.spawnSync(['bun', '--bun', 'prisma', 'migrate', 'deploy'], {
  cwd: new URL('../../../packages/db/', import.meta.url).pathname,
  env: { ...process.env, DATABASE_URL: url },
  stdout: 'pipe',
  stderr: 'pipe',
});
if (migrate.exitCode !== 0) {
  throw new Error(`prisma migrate deploy failed:\n${migrate.stderr.toString()}`);
}

const db = createPrismaClient(url);
try {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
} finally {
  await db.$disconnect();
}
