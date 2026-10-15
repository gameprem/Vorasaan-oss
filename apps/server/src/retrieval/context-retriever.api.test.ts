import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { ContextBlock } from '../ai/ai.port.ts';
import { CONTEXT_CEILINGS } from '../ai/context-budget.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { ContentChunkRepository, keywordTerms } from './content-chunk.repository.ts';
import { blockTokens, ContextRetriever, splitFeatureSpec } from './context-retriever.ts';
import { EmbeddingError } from './embedding.port.ts';
import type { FakeEmbeddings } from './fake-embedding.port.ts';
import { IndexingService } from './indexing.service.ts';
import {
  FEATURE_ATTACHMENTS,
  NEEDLE_PARAGRAPH,
  NEEDLE_QUESTION,
  OTHER_FEATURES,
  OTHER_PROJECT_DECOY,
} from './large-project.fixture.ts';

const { pim, beam } = SEED.users;
const QUERY = `${NEEDLE_QUESTION.title}\n\n${NEEDLE_QUESTION.description}`;
const OTHER_FEATURE_ATTACHMENT = 'OTHER-FEATURE-ATTACHMENT';

const total = (blocks: ContextBlock[]) => blocks.reduce((n, b) => n + blockTokens(b), 0);

describe('ContextRetriever (real Postgres with pgvector)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let embeddings: FakeEmbeddings;
  let retriever: ContextRetriever;
  let indexing: IndexingService;
  let chunks: ContentChunkRepository;
  let asPim: ReturnType<typeof as>;
  let fixture: {
    handbookId: string;
    otherSpecIds: string[];
    openRequestId: string;
    decisionId: string;
  };

  async function configureEmbeddings() {
    const res = await asPim('PUT', '/settings/embeddings', {
      baseUrl: 'https://embeddings.example.test/v1',
      model: 'embed-a',
      apiKey: 'sk-test',
    });
    expect(res.status).toBe(200);
  }

  async function attach(featureId: string, title: string, text: string) {
    const attachment = await db.attachment.create({
      data: {
        featureId,
        source: 'FILE',
        title,
        snapshotText: text,
        snapshotAt: new Date(),
        addedById: pim.id,
      },
    });
    return attachment.id;
  }

  /** The large multi-document Project, indexed now (not in the background). */
  async function buildProject() {
    const attachmentIds: string[] = [];
    for (const doc of FEATURE_ATTACHMENTS) {
      attachmentIds.push(await attach(SEED.featureId, doc.title, doc.text));
    }
    const otherSpecIds: string[] = [];
    for (const other of OTHER_FEATURES) {
      const feature = await db.feature.create({
        data: { teamId: SEED.teamId, title: other.title },
      });
      const version = await db.specVersion.create({
        data: {
          featureId: feature.id,
          version: 1,
          markdown: other.spec,
          source: 'MANUAL',
          approvedById: pim.id,
        },
      });
      otherSpecIds.push(version.id);
      // Another Feature's Attachment is that Feature's, not the Project's: never retrieved.
      attachmentIds.push(
        await attach(feature.id, 'Other Feature notes', `${OTHER_FEATURE_ATTACHMENT} ${QUERY}`),
      );
    }
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Card Issuing' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Cards' } });
    const elsewhere = await db.feature.create({ data: { teamId: team.id, title: 'Cards' } });
    attachmentIds.push(
      await attach(elsewhere.id, OTHER_PROJECT_DECOY.title, OTHER_PROJECT_DECOY.text),
    );

    const open = await db.decisionRequest.create({
      data: {
        featureId: SEED.featureId,
        kind: 'QUESTION',
        raiserId: beam.id,
        title: 'Which statuses does the order card show?',
        description: 'Processing, Paid and Payment failed only?',
        deciderRole: 'PO',
        status: 'OPEN',
      },
    });
    const decided = await db.decisionRequest.create({
      data: {
        featureId: SEED.featureId,
        kind: 'BLOCKER',
        raiserId: beam.id,
        title: 'Provider has no webhook',
        description: 'Only polling is available.',
        deciderRole: 'PO',
        status: 'DECIDED',
      },
    });
    const decision = await db.decision.create({
      data: {
        requestId: decided.id,
        decidedById: pim.id,
        customAnswer: 'Poll every 5 seconds for up to 24 hours.',
      },
    });

    for (const id of attachmentIds) await indexing.index({ source: 'ATTACHMENT', id });
    for (const id of otherSpecIds) await indexing.index({ source: 'SPEC_VERSION', id });
    await indexing.index({ source: 'DECISION', id: decision.id });
    const [handbookId] = attachmentIds;
    if (!handbookId) throw new Error('expected the handbook');
    fixture = { handbookId, otherSpecIds, openRequestId: open.id, decisionId: decision.id };
  }

  function expectNoLeak(blocks: ContextBlock[]) {
    for (const block of blocks) {
      expect(block.text).not.toContain('DECOY-OTHER-PROJECT');
      expect(block.text).not.toContain(OTHER_FEATURE_ATTACHMENT);
    }
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    ({ app, embeddings } = testApp);
    db = createTestPrisma();
    retriever = app.get(ContextRetriever);
    indexing = app.get(IndexingService);
    chunks = app.get(ContentChunkRepository);
    asPim = as(app, pim.id);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    embeddings.reset();
  });

  test("the Feature's own Spec always comes first, then its material, then the Project's; never over budget", async () => {
    await configureEmbeddings();
    await buildProject();
    const spec = await db.specVersion.findFirstOrThrow({ where: { featureId: SEED.featureId } });

    for (const budget of [
      150,
      400,
      1_000,
      2_500,
      CONTEXT_CEILINGS.decisionRequest,
      15_000,
      60_000,
    ]) {
      const blocks = await retriever.forFeature(SEED.featureId, QUERY, budget);
      expect(total(blocks)).toBeLessThanOrEqual(budget);
      expect(blocks[0]?.source).toEqual({
        kind: 'SPEC_VERSION',
        id: spec.id,
        title: 'Spec: Async checkout',
        version: 1,
      });
      expect(blocks[0]?.scope).toBe('FEATURE');
      // The Feature's own material and best-matching chunks come before the Project's.
      const firstProject = blocks.findIndex((b) => b.scope === 'PROJECT');
      const needle = blocks.findIndex((b) => b.text.includes(NEEDLE_PARAGRAPH));
      const ownIds = [fixture.openRequestId, fixture.decisionId];
      const lastOwn = blocks.findLastIndex((b) => ownIds.includes(b.source.id));
      if (firstProject !== -1) {
        expect(firstProject).toBeGreaterThan(Math.max(0, needle, lastOwn));
      }
      expectNoLeak(blocks);
    }

    // A small budget shortens the Spec rather than letting anything else come first.
    const tiny = await retriever.forFeature(SEED.featureId, QUERY, 150);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]?.text).toContain('[Shortened to fit the AI context budget]');
    // Too small for even a fragment of the Spec: nothing at all.
    expect(await retriever.forFeature(SEED.featureId, QUERY, 40)).toEqual([]);

    // With room, every kind of block is there, each cited by its source's id.
    const all = await retriever.forFeature(SEED.featureId, QUERY, 60_000);
    const ids = new Set(all.map((b) => b.source.id));
    expect(ids.has(fixture.openRequestId)).toBe(true);
    expect(ids.has(fixture.decisionId)).toBe(true);
    expect(ids.has(fixture.handbookId)).toBe(true);
    for (const id of fixture.otherSpecIds) expect(ids.has(id)).toBe(true);
    const otherSpec = all.find((b) => b.source.id === fixture.otherSpecIds[0]);
    expect(otherSpec?.scope).toBe('PROJECT');
    expect(otherSpec?.source.title).toBe('Spec: Card refunds');
    expect(otherSpec?.source.version).toBe(1);
    // Our own Decision comes whole from the Feature, not again as a Project chunk.
    expect(all.filter((b) => b.source.id === fixture.decisionId)).toHaveLength(1);
    // No block twice.
    const texts = all.map((b) => b.text);
    expect(new Set(texts).size).toBe(texts.length);

    // A request the prompt already shows in full is left out.
    const excluding = await retriever.forFeature(SEED.featureId, QUERY, 60_000, {
      excludeRequestId: fixture.openRequestId,
    });
    expect(excluding.some((b) => b.source.id === fixture.openRequestId)).toBe(false);

    const { spec: split, context } = splitFeatureSpec(all);
    expect(split?.source.id).toBe(spec.id);
    expect(context.some((b) => b.source.kind === 'SPEC_VERSION' && b.scope === 'FEATURE')).toBe(
      false,
    );
  });

  test('a query matching one paragraph in a large Attachment retrieves that paragraph', async () => {
    await configureEmbeddings();
    await buildProject();
    const handbook = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: fixture.handbookId });
    expect(handbook.length).toBeGreaterThanOrEqual(25);
    expect(handbook.every((c) => c.embeddingModel === 'embed-a')).toBe(true);

    const blocks = await retriever.forFeature(
      SEED.featureId,
      QUERY,
      CONTEXT_CEILINGS.decisionRequest,
    );
    expect(embeddings.calls.at(-1)?.texts).toEqual([QUERY]);
    const attachments = blocks.filter((b) => b.source.kind === 'ATTACHMENT');
    expect(attachments[0]?.source.id).toBe(fixture.handbookId);
    expect(attachments[0]?.text).toContain(NEEDLE_PARAGRAPH);
    // Only the relevant part of the handbook, not the whole of it.
    const fromHandbook = attachments.filter((b) => b.source.id === fixture.handbookId);
    expect(fromHandbook.length).toBeLessThan(handbook.length);
    expect(total(blocks)).toBeLessThanOrEqual(CONTEXT_CEILINGS.decisionRequest);
    expectNoLeak(blocks);
  });

  test('a section copied into another Attachment, and the overlap of a long one, are sent once (0076)', async () => {
    await configureEmbeddings();
    const sentences = Array.from(
      { length: 40 },
      (_, i) =>
        `Payout rule ${i + 1}: batches after 22:30 settle on working day ${i + 2} for PromptPay.`,
    );
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      sentences.slice(i * 4, i * 4 + 4).join(' '),
    );
    const section = `## Payouts\n${paragraphs.join('\n\n')}`;
    const handbook = await attach(SEED.featureId, 'Payouts handbook', `# Handbook\n\n${section}`);
    const archive = await attach(
      SEED.featureId,
      'Handbook archive',
      `# Archive\n\n${section.replace('## Payouts', '## Payouts (2025 archive)')}`,
    );
    for (const id of [handbook, archive]) await indexing.index({ source: 'ATTACHMENT', id });
    // The long section is cut into pieces that overlap, and the archive repeats them all.
    const pieces = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: handbook });
    expect(pieces.length).toBeGreaterThan(1);

    const blocks = await retriever.forFeature(
      SEED.featureId,
      'When do payout batches settle for PromptPay?',
      CONTEXT_CEILINGS.decisionRequest,
    );
    const sent = blocks.map((b) => b.text).join('\n\n');
    for (const sentence of sentences) {
      // Every rule is sent, and none twice: no overlap, no archive copy.
      expect(sent.split(sentence).length - 1, sentence).toBe(1);
    }
  });

  test('without embeddings, the keyword fallback returns the same paragraph', async () => {
    await buildProject();
    const handbook = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: fixture.handbookId });
    expect(handbook.every((c) => c.embedding === null)).toBe(true);

    const blocks = await retriever.forFeature(
      SEED.featureId,
      QUERY,
      CONTEXT_CEILINGS.decisionRequest,
    );
    expect(embeddings.calls).toHaveLength(0);
    const attachments = blocks.filter((b) => b.source.kind === 'ATTACHMENT');
    expect(attachments[0]?.source.id).toBe(fixture.handbookId);
    expect(attachments[0]?.text).toContain(NEEDLE_PARAGRAPH);
    expectNoLeak(blocks);
  });

  test('when the embeddings provider fails, the keyword fallback still finds the paragraph', async () => {
    await configureEmbeddings();
    await buildProject();
    embeddings.failWith = new EmbeddingError('embeddings.example.test answered HTTP 503');

    const blocks = await retriever.forFeature(
      SEED.featureId,
      QUERY,
      CONTEXT_CEILINGS.decisionRequest,
    );
    const attachments = blocks.filter((b) => b.source.kind === 'ATTACHMENT');
    expect(attachments[0]?.text).toContain(NEEDLE_PARAGRAPH);
    expectNoLeak(blocks);
  });

  test('keyword search takes any text as a parameter and stays in its Project', async () => {
    await buildProject();
    const hostile = `'); DROP TABLE "ContentChunk"; -- & | ! <-> :* ${NEEDLE_QUESTION.title}`;
    expect(keywordTerms(hostile)).toEqual([
      'drop',
      'table',
      'contentchunk',
      'promptpay',
      'settlement',
      'cutoff',
    ]);
    const hits = await chunks.keywordSearch(
      { organizationId: SEED.organizationId, projectId: SEED.projectId },
      hostile,
      100,
    );
    expect(hits.some((h) => h.text.includes(NEEDLE_PARAGRAPH))).toBe(true);
    expect(hits.some((h) => h.text.includes('DECOY-OTHER-PROJECT'))).toBe(false);
    expect(
      await chunks.keywordSearch(
        { organizationId: SEED.organizationId, projectId: SEED.projectId },
        '!!! ???',
        5,
      ),
    ).toEqual([]);
    expect(await db.contentChunk.count()).toBeGreaterThan(0);
  });

  test('chunks that rank alike come back in the same order, however the rows lie on disk (0076)', async () => {
    // Every chunk below shares no word and no direction with the query: each is at exactly
    // distance 1 and has the same keyword rank. Only the tie-break decides which k come back.
    const scope = { organizationId: SEED.organizationId, projectId: SEED.projectId };
    const dims = 4;
    const query = { model: 'tie-test', embedding: [1, 0, 0, 0] };
    const tied = [0, 1, 0, 0];
    const index = async (sourceId: string, texts: string[], near?: number) => {
      const vectors = texts.map((_, i) => (i === near ? [1, 0, 0, 0] : tied));
      await chunks.replace(
        { ...scope, featureId: null },
        { source: 'ATTACHMENT', sourceId },
        texts.map((text, position) => ({ position, text, tokenCount: 3 })),
        { model: query.model, vectors },
      );
    };
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    await index(older, ['tie zeta', 'tie alpha', 'tie needle'], 2);
    await index(newer, ['tie Zulu', 'tie bravo', 'tie delta']);
    const where = { ...scope, sources: ['ATTACHMENT' as const] };
    const read = async () => ({
      vector: (await chunks.search(where, query, 4)).map((h) => h.text),
      keyword: (await chunks.keywordSearch(where, 'tie', 4)).map((h) => h.text),
    });

    // The nearest first; then, among equals, the most recently indexed source in reading order.
    const expected = {
      vector: ['tie needle', 'tie Zulu', 'tie bravo', 'tie delta'],
      keyword: ['tie Zulu', 'tie bravo', 'tie delta', 'tie zeta'],
    };
    expect(await read()).toEqual(expected);
    // Rewriting rows moves them to the end of the table: the order on disk changes, the answer doesn't.
    for (const sourceId of [newer, older, newer]) {
      await db.$executeRaw`UPDATE "ContentChunk" SET "text" = "text" WHERE "sourceId" = ${sourceId}`;
      expect(await read()).toEqual(expected);
    }

    // Indexed at the same instant: reading order, then the text byte by byte, whatever the
    // database's collation ('Z' sorts before 'a' in "C", after it in en-US).
    await db.$executeRaw`UPDATE "ContentChunk" SET "createdAt" = '2026-06-01T10:00:00Z'`;
    for (const sourceId of [older, newer]) {
      await db.$executeRaw`UPDATE "ContentChunk" SET "text" = "text" WHERE "sourceId" = ${sourceId}`;
      expect(await read()).toEqual({
        vector: ['tie needle', 'tie Zulu', 'tie zeta', 'tie alpha'],
        keyword: ['tie Zulu', 'tie zeta', 'tie alpha', 'tie bravo'],
      });
    }
  });

  test('an unknown Feature gets no context', async () => {
    expect(await retriever.forFeature(crypto.randomUUID(), QUERY, 1_000)).toEqual([]);
  });

  describe('forProject (Grilling)', () => {
    async function projectMaterial() {
      await buildProject();
      const brief = await db.briefVersion.create({
        data: {
          projectId: SEED.projectId,
          version: 1,
          markdown: '# Project Brief\n\n## Business goals\nGrow mobile payments.\n',
          source: 'MANUAL',
          approvedById: pim.id,
        },
      });
      const repoScan = await db.attachment.create({
        data: {
          projectId: SEED.projectId,
          source: 'REPO_SCAN',
          title: 'Repo Scan: mobile-bank',
          snapshotText: `# mobile-bank\n\nModules: payments, cards. ${NEEDLE_PARAGRAPH}`,
          snapshotAt: new Date(),
          addedById: pim.id,
        },
      });
      await indexing.index({ source: 'BRIEF_VERSION', id: brief.id });
      await indexing.index({ source: 'ATTACHMENT', id: repoScan.id });
      return { briefId: brief.id, repoScanId: repoScan.id };
    }

    test('the Brief first, then the Features and Project Attachments; never a Feature Attachment or another Project', async () => {
      await configureEmbeddings();
      const { briefId, repoScanId } = await projectMaterial();
      for (const budget of [150, 1_000, CONTEXT_CEILINGS.grilling, 60_000]) {
        const blocks = await retriever.forProject(SEED.projectId, QUERY, budget);
        expect(total(blocks)).toBeLessThanOrEqual(budget);
        expect(blocks[0]?.source).toEqual({
          kind: 'BRIEF_VERSION',
          id: briefId,
          title: 'Project Brief',
          version: 1,
        });
        // The Brief is whole, so its chunks never repeat it.
        expect(blocks.filter((b) => b.source.id === briefId)).toHaveLength(1);
        expect(blocks.every((b) => b.scope === 'PROJECT')).toBe(true);
        expectNoLeak(blocks);
        // The Feature's own Attachments belong to it, not to the Project.
        expect(blocks.some((b) => b.source.id === fixture.handbookId)).toBe(false);
      }
      const blocks = await retriever.forProject(SEED.projectId, QUERY, CONTEXT_CEILINGS.grilling);
      const titles = blocks.map((b) => b.source.title);
      expect(titles).toContain('Spec: Async checkout');
      for (const other of OTHER_FEATURES) expect(titles).toContain(`Spec: ${other.title}`);
      const scan = blocks.findIndex((b) => b.source.id === repoScanId);
      expect(scan).toBeGreaterThan(0);
      expect(blocks[scan]?.text).toContain(NEEDLE_PARAGRAPH.slice(0, 40));

      // With a tiny budget, the Brief is all there is room for.
      const tiny = await retriever.forProject(SEED.projectId, QUERY, 80);
      expect(tiny.map((b) => b.source.id)).toEqual([briefId]);
    });

    test('an unknown Project gets no context', async () => {
      expect(await retriever.forProject(crypto.randomUUID(), QUERY, 1_000)).toEqual([]);
    });
  });
});
