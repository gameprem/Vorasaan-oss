import { createPrismaClient, type PrismaClient } from '@vorasaan/db';
import pg from 'pg';

// Tests run against a real Postgres database whose name must end in "_test",
// so a misconfigured env can never truncate a dev database.
const DEFAULT_TEST_URL = 'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_test';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;

const dbPackageDir = new URL('../../../../packages/db/', import.meta.url).pathname;

let prepared: Promise<void> | undefined;

async function ensureDatabaseExists(url: string) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use "${name}" for tests: the database name must end in _test`);
  }
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

async function migrate(url: string) {
  const proc = Bun.spawn(['bun', '--bun', 'prisma', 'migrate', 'deploy'], {
    cwd: dbPackageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${await new Response(proc.stderr).text()}`);
  }
}

/** Creates the test database if needed and applies migrations, once per test run. */
export function prepareTestDatabase(): Promise<void> {
  prepared ??= ensureDatabaseExists(testDatabaseUrl).then(() => migrate(testDatabaseUrl));
  return prepared;
}

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(testDatabaseUrl);
}

/**
 * Waits registered before each truncate: test apps register their background
 * indexing here, so a job left over from the previous test can't deadlock TRUNCATE
 * or write into the next test's data.
 */
export const beforeTruncate = new Set<() => Promise<void>>();

/** Empties every application table. Call in beforeEach. */
export async function truncateAll(db: PrismaClient) {
  for (const wait of beforeTruncate) await wait();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
