import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import { InjectPrisma, PRISMA } from '../prisma/prisma.module.ts';
import type { RecordedQuery } from '../test/app.ts';
import {
  createTestPrisma,
  prepareTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../test/database.ts';
import {
  compare,
  formatTable,
  measure,
  N_PLUS_ONE_REPEATS,
  percentile,
  type QueryRecorder,
  statementShape,
} from './bench.ts';

const FEATURES = 15;

/** Two scripted endpoints that answer the same thing: one queries per row, one joins. */
@Controller('scripted')
class ScriptedController {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  @Get('per-row')
  async perRow() {
    const features = await this.db.feature.findMany({ where: { teamId: SEED.teamId } });
    return Promise.all(
      features.map(async (f) => ({
        id: f.id,
        latest: await this.db.specVersion.findFirst({
          where: { featureId: f.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        }),
      })),
    );
  }

  @Get('joined')
  async joined() {
    const features = await this.db.feature.findMany({
      where: { teamId: SEED.teamId },
      include: { specVersions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    return features.map((f) => ({ id: f.id, latest: f.specVersions[0] ?? null }));
  }
}

describe('The benchmark harness (ticket 0073)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let appDb: PrismaClient;
  let recording: RecordedQuery[] | null = null;
  const record: QueryRecorder = async (run) => {
    const queries: RecordedQuery[] = [];
    recording = queries;
    try {
      return { result: await run(), queries };
    } finally {
      recording = null;
    }
  };
  const get = (url: string) => async () => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
  };

  beforeAll(async () => {
    await prepareTestDatabase();
    db = createTestPrisma();
    await truncateAll(db);
    await seed(db);
    for (let i = 0; i < FEATURES - 1; i++) {
      const feature = await db.feature.create({
        data: { teamId: SEED.teamId, title: `Scripted ${i}` },
      });
      await db.specVersion.create({
        data: {
          featureId: feature.id,
          version: 1,
          markdown: '# Spec',
          source: 'MANUAL',
          approvedById: SEED.users.pim.id,
        },
      });
    }

    appDb = createPrismaClient(testDatabaseUrl, {
      onQuery: (sql, durationMs) => recording?.push({ sql, durationMs }),
    });
    @Module({
      controllers: [ScriptedController],
      providers: [{ provide: PRISMA, useValue: appDb }],
    })
    class ScriptedModule {}
    const moduleRef = await Test.createTestingModule({ imports: [ScriptedModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await appDb.$disconnect();
    await truncateAll(db);
    await db.$disconnect();
  });

  test('catches an N+1: an endpoint that queries per row exceeds its query count', async () => {
    const result = await measure(
      {
        name: 'per-row',
        description: 'Features with their latest Spec Version, one query per Feature',
        run: get('/scripted/per-row'),
        iterations: 3,
        warmup: 1,
        queryBudget: 3,
      },
      record,
    );
    expect(result.queries.max).toBe(1 + FEATURES);
    expect(result.overBudget).toBe(true);
    expect(result.nPlusOne).toBe(true);
    expect(result.mostRepeated?.count).toBe(FEATURES);
    expect(result.mostRepeated?.sql).toContain('"SpecVersion"');
    expect(formatTable([result])).toContain('N+1, over budget (3)');
  });

  test('the same answer in a fixed few queries stays within its budget', async () => {
    const result = await measure(
      {
        name: 'joined',
        description: 'Features with their latest Spec Version, joined',
        run: get('/scripted/joined'),
        iterations: 3,
        queryBudget: 3,
      },
      record,
    );
    expect(result.queries.max).toBeLessThanOrEqual(3);
    expect(result.overBudget).toBe(false);
    expect(result.nPlusOne).toBe(false);
    expect(result.ms.p50).toBeGreaterThan(0);
    expect(result.ms.p95).toBeGreaterThanOrEqual(result.ms.p50);
    expect(result.dbMs.p50).toBeGreaterThanOrEqual(0);
    // A report is JSON as well as a table.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('percentiles, statement shapes and comparisons', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile([], 0.5)).toBe(0);
    expect(statementShape('SELECT  *\n FROM "A" WHERE "id" IN ($1,$2, $3) AND x = $4')).toBe(
      'SELECT * FROM "A" WHERE "id" IN (?...) AND x = ?',
    );
    expect(N_PLUS_ONE_REPEATS).toBeLessThan(FEATURES);
    const row = (p95: number) =>
      ({ name: 'inbox', ms: { p95 }, queries: { max: 6 } }) as Parameters<typeof compare>[0][0];
    expect(compare([row(100)], [row(80)])).toEqual([
      { name: 'inbox', baselineP95: 100, p95: 80, p95Change: -20, baselineQueries: 6, queries: 6 },
    ]);
  });
});
