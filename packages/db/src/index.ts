import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export type PrismaClientOptions = {
  /**
   * Called with each SQL statement the client sends and how long it took in milliseconds
   * (tests count queries with it; the benchmark also sums their time).
   */
  onQuery?: (sql: string, durationMs: number) => void;
};

// Prisma 7 requires a driver adapter; the connection string comes from the caller
// so the server and tests can point at different databases.
export function createPrismaClient(
  connectionString: string,
  options: PrismaClientOptions = {},
): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  const { onQuery } = options;
  if (!onQuery) return new PrismaClient({ adapter });
  const client = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (event) => onQuery(event.query, Number(event.duration)));
  return client as unknown as PrismaClient;
}
