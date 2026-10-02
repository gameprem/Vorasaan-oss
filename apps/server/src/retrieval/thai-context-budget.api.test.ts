import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { ContextBlock } from '../ai/ai.port.ts';
import { CONTEXT_CEILINGS } from '../ai/context-budget.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { BLOCK_OVERHEAD_TOKENS, ContextRetriever } from './context-retriever.ts';
import { IndexingService } from './indexing.service.ts';
import fixture from './token-fixture.counts.json';
import { THAI_FEATURES, TOKEN_SAMPLES } from './token-fixture.ts';

const counts: Record<string, { tokens: number }> = fixture.counts;
const realByText = new Map(TOKEN_SAMPLES.map((s) => [s.text, counts[s.id]?.tokens]));

/** A block's cost measured with the fixture tokenizer: every text in it has a checked-in count. */
function realTokens(block: ContextBlock): number {
  const text = realByText.get(block.text);
  const title = realByText.get(block.source.title);
  if (text === undefined || title === undefined) {
    throw new Error(`No fixture count for the block "${block.source.title}"`);
  }
  return text + title + BLOCK_OVERHEAD_TOKENS;
}

describe('a Feature context of Thai Specs (ticket 0059, real Postgres)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let retriever: ContextRetriever;
  let indexing: IndexingService;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    retriever = app.get(ContextRetriever);
    indexing = app.get(IndexingService);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
  });

  test('never goes over its budget, measured with the fixture tokenizer', async () => {
    const res = await as(app, SEED.users.pim.id)('PUT', '/settings/embeddings', {
      baseUrl: 'https://embeddings.example.test/v1',
      model: 'embed-a',
      apiKey: 'sk-test',
    });
    expect(res.status).toBe(200);
    const featureIds: string[] = [];
    for (const { title, spec } of THAI_FEATURES) {
      const feature = await db.feature.create({
        data: { teamId: SEED.teamId, title: title.text.replace(/^Spec: /, '') },
      });
      const version = await db.specVersion.create({
        data: {
          featureId: feature.id,
          version: 1,
          markdown: spec.text,
          source: 'MANUAL',
          approvedById: SEED.users.pim.id,
        },
      });
      await indexing.index({ source: 'SPEC_VERSION', id: version.id });
      featureIds.push(feature.id);
    }
    const [own] = featureIds;
    if (!own) throw new Error('expected a Feature');
    const query = 'ลูกค้าชำระเงินแล้วต้องคืนเงินอย่างไร';

    for (const budget of [500, 750, 1_000, 1_500, 2_000, CONTEXT_CEILINGS.decisionRequest]) {
      const blocks = await retriever.forFeature(own, query, budget);
      expect(blocks[0]?.source.title).toBe(THAI_FEATURES[0]?.title.text);
      const real = blocks.reduce((sum, b) => sum + realTokens(b), 0);
      expect({ budget, real: Math.min(real, budget) }).toEqual({ budget, real });
    }
    // With room for everything, every Thai Spec is there: the check above isn't vacuous.
    const all = await retriever.forFeature(own, query, CONTEXT_CEILINGS.decisionRequest);
    expect(all).toHaveLength(THAI_FEATURES.length);
  });
});
