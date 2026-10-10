import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export type PrismaClientOptions = {
  /**
   * Called with each SQL statement the client sends and how long it took in milliseconds
   * (tests count queries with it; the benchmark also sums their time).
   */
  onQuery?: (sql: string, durationMs: number) => void;
  /**
   * The most connections this client opens (default DEFAULT_POOL_SIZE). One server
   * process shares one pool between requests and its background jobs; see
   * docs/performance.md, "Connection pool".
   */
  poolSize?: number;
};

/** pg's own default, kept explicit: what one server process opens at most (ticket 0074). */
export const DEFAULT_POOL_SIZE = 10;

/** `DATABASE_POOL_SIZE` from the environment, or undefined when unset or not a positive integer. */
export function poolSizeFromEnv(value = process.env.DATABASE_POOL_SIZE): number | undefined {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : undefined;
}

// Prisma 7 requires a driver adapter; the connection string comes from the caller
// so the server and tests can point at different databases.
export function createPrismaClient(
  connectionString: string,
  options: PrismaClientOptions = {},
): PrismaClient {
  const { onQuery, poolSize = DEFAULT_POOL_SIZE } = options;
  const adapter = new PrismaPg({ connectionString, max: poolSize });
  if (!onQuery) return new PrismaClient({ adapter });
  const client = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (event) => onQuery(event.query, Number(event.duration)));
  return client as unknown as PrismaClient;
}
