import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AttachmentView,
  BriefVersionView,
  DecideResult,
  DecisionRequestView,
  EmbeddingSettingsView,
  EmbeddingTestResult,
  ReindexResult,
  SpecVersionView,
} from '@vorasaan/shared';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { CHUNKING } from './chunker.ts';
import { ContentChunkRepository } from './content-chunk.repository.ts';
import { ContextRetriever } from './context-retriever.ts';
import { EmbeddingError } from './embedding.port.ts';
import { type FakeEmbeddings, fakeEmbedding } from './fake-embedding.port.ts';
import { estimateTokens } from './token-estimate.ts';
import { THAI_SAMPLES } from './token-fixture.ts';

const { pim, beam } = SEED.users;
const API_KEY = 'sk-embeddings-secret-key-0036';
const PROVIDER = { baseUrl: 'https://embeddings.example.test/v1', model: 'embed-a' };

const repeat = (sentence: string) => Array.from({ length: 14 }, () => sentence).join(' ');

/** Three sections, each long enough to be a chunk of its own. */
const HANDBOOK = `# Payments handbook

## Webhooks
The payment provider sends a webhook when a charge settles. We verify the webhook
signature with the shared secret before trusting the payload.
${repeat('Webhook deliveries are retried with backoff while our endpoint is down.')}

## Refunds
Refunds are issued by support agents from the admin console. A refund reverses the
charge and emails the customer a receipt.
${repeat('A partial refund keeps the rest of the charge captured.')}

## Onboarding
New merchants upload identity documents and a bank statement during onboarding.
${repeat('Merchants wait for a compliance review before going live.')}
`;

/** A multipart/form-data body with one file. */
function multipart(filename: string, content: string) {
  const boundary = `----vorasaan${crypto.randomUUID()}`;
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Indexing and search (pgvector)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let embeddings: FakeEmbeddings;
  let drain: () => Promise<void>;
  let chunks: ContentChunkRepository;
  let storageDir: string;
  let pages: ReturnType<typeof Bun.serve>;
  let pageHtml: string;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  /** Attaches a file to a Feature, or to a Project with `{ projectId }`. */
  async function upload(owner: string | { projectId: string }, filename: string, content: string) {
    const body = multipart(filename, content);
    const res = await app.inject({
      method: 'POST',
      url:
        typeof owner === 'string'
          ? `/features/${owner}/attachments`
          : `/projects/${owner.projectId}/attachments`,
      headers: { ...body.headers, [DEV_USER_HEADER]: pim.id },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as AttachmentView;
  }

  async function configure(input: Record<string, string> = { ...PROVIDER, apiKey: API_KEY }) {
    const res = await asPim<EmbeddingSettingsView>('PUT', '/settings/embeddings', input);
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Another Project (and Feature) in the same Organization. */
  async function otherProjectFeature() {
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Card Issuing' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Cards' } });
    const feature = await db.feature.create({ data: { teamId: team.id, title: 'Card refunds' } });
    return { projectId: project.id, featureId: feature.id };
  }

  const query = (text: string, model = PROVIDER.model) => ({
    model,
    embedding: fakeEmbedding(text, embeddings.dims),
  });

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'vorasaan-indexing-'));
    process.env.FILE_STORAGE_DRIVER = 'local';
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir;
    process.env.ATTACHMENT_ALLOW_PRIVATE_URLS = 'true';
    pages = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(pageHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    const testApp = await createTestApp();
    ({ app, embeddings } = testApp);
    drain = testApp.drainIndexing;
    chunks = app.get(ContentChunkRepository);
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    delete process.env.ATTACHMENT_ALLOW_PRIVATE_URLS;
    pages.stop(true);
    await db.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db); // waits for indexing left over from the previous test
    await seed(db);
    embeddings.reset();
  });

  describe('Settings → Embeddings', () => {
    test('Admins save the endpoint; the key is encrypted and never returned', async () => {
      expect((await asPim<EmbeddingSettingsView>('GET', '/settings/embeddings')).body).toEqual({
        configured: false,
        baseUrl: null,
        model: null,
        apiKeySet: false,
      });

      const saved = await configure();
      expect(saved).toEqual({ configured: true, ...PROVIDER, apiKeySet: true });

      const res = await app.inject({
        method: 'GET',
        url: '/settings/embeddings',
        headers: { [DEV_USER_HEADER]: pim.id },
      });
      expect(res.body).not.toContain(API_KEY);
      const stored = await db.orgIntegration.findFirstOrThrow({
        where: { provider: 'EMBEDDINGS' },
      });
      expect(stored.secretEncrypted).not.toContain(API_KEY);

      expect((await asBeam('GET', '/settings/embeddings')).status).toBe(403);
      expect((await asBeam('PUT', '/settings/embeddings', PROVIDER)).status).toBe(403);
      expect((await asBeam('POST', '/settings/embeddings/reindex', {})).status).toBe(403);
    });

    test('test-connection reports the dimension without saving', async () => {
      const ok = await asPim<EmbeddingTestResult>('POST', '/settings/embeddings/test', {
        ...PROVIDER,
        apiKey: API_KEY,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        ok: true,
        message: 'Connected to embed-a: 256 dimensions',
        dimensions: 256,
      });
      expect(embeddings.configs.at(-1)).toEqual({ ...PROVIDER, apiKey: API_KEY });
      expect(await db.orgIntegration.count({ where: { provider: 'EMBEDDINGS' } })).toBe(0);

      embeddings.failWith = new EmbeddingError(
        'embeddings.example.test answered HTTP 401: bad key',
      );
      const failed = await asPim<EmbeddingTestResult>('POST', '/settings/embeddings/test', {
        ...PROVIDER,
        apiKey: API_KEY,
      });
      expect(failed.body).toEqual({
        ok: false,
        message: 'embeddings.example.test answered HTTP 401: bad key',
        dimensions: null,
      });
    });

    test('the stored key is reused only for the same host', async () => {
      await configure();
      await configure({ ...PROVIDER, model: 'embed-b' });
      const test1 = await asPim<EmbeddingTestResult>('POST', '/settings/embeddings/test', {
        ...PROVIDER,
      });
      expect(test1.body.ok).toBe(true);
      expect(embeddings.configs.at(-1)?.apiKey).toBe(API_KEY);

      const moved = { baseUrl: 'https://attacker.example.test/v1', model: 'embed-a' };
      expect((await asPim('PUT', '/settings/embeddings', moved)).status).toBe(422);
      const test2 = await asPim<EmbeddingTestResult>('POST', '/settings/embeddings/test', moved);
      expect(test2.body).toMatchObject({ ok: false, dimensions: null });
      expect(embeddings.configs.every((c) => !c.baseUrl.includes('attacker'))).toBe(true);
    });
  });

  test('attaching a Markdown file creates chunks with embeddings; refreshing replaces them', async () => {
    await configure();
    const attachment = await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    await drain();

    const ref = { source: 'ATTACHMENT' as const, sourceId: attachment.id };
    const first = await chunks.chunksOf(ref);
    expect(first.map((c) => c.text.split('\n')[0])).toEqual([
      '# Payments handbook',
      '## Refunds',
      '## Onboarding',
    ]);
    expect(first.map((c) => c.text).join('\n')).toContain('shared secret');
    for (const chunk of first) {
      expect(chunk).toMatchObject({
        featureId: SEED.featureId,
        projectId: SEED.projectId,
        embeddingModel: 'embed-a',
        embeddingDims: 256,
      });
      expect(chunk.embedding).toHaveLength(256);
    }

    // A new model, then Refresh: the same chunks, re-embedded, not duplicated.
    await configure({ ...PROVIDER, model: 'embed-b' });
    expect((await asPim('POST', `/attachments/${attachment.id}/refresh`)).status).toBe(201);
    await drain();
    const refreshed = await chunks.chunksOf(ref);
    expect(refreshed.map((c) => c.text)).toEqual(first.map((c) => c.text));
    expect(refreshed.every((c) => c.embeddingModel === 'embed-b')).toBe(true);
    expect(await db.contentChunk.count()).toBe(refreshed.length);
  });

  test('refreshing a URL Attachment whose page changed replaces its chunks with the new text', async () => {
    await configure();
    pageHtml =
      '<html><body><main><h1>Limits</h1><p>Daily transfer limit is 500.</p></main></body></html>';
    const added = await asPim<AttachmentView>('POST', `/features/${SEED.featureId}/attachments`, {
      source: 'URL',
      url: `${pages.url.origin}/limits`,
    });
    expect(added.status).toBe(201);
    await drain();
    const ref = { source: 'ATTACHMENT' as const, sourceId: added.body.id };
    expect((await chunks.chunksOf(ref)).map((c) => c.text).join()).toContain('500');

    pageHtml =
      '<html><body><main><h1>Limits</h1><p>Daily transfer limit is 900.</p></main></body></html>';
    await asPim('POST', `/attachments/${added.body.id}/refresh`);
    await drain();
    const texts = (await chunks.chunksOf(ref)).map((c) => c.text).join();
    expect(texts).toContain('900');
    expect(texts).not.toContain('500');

    // Removing the Attachment removes its chunks.
    expect((await asPim('DELETE', `/attachments/${added.body.id}`)).status).toBe(204);
    await drain();
    expect(await chunks.chunksOf(ref)).toEqual([]);
  });

  test('search returns the relevant chunk first, and never chunks from another Project', async () => {
    await configure();
    await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    const other = await otherProjectFeature();
    // The other Project has a document that matches the query even better.
    await upload(
      other.featureId,
      'cards.md',
      '# Refunds\nRefunds refunds refund receipt support agents.',
    );
    await drain();

    const scope = { organizationId: SEED.organizationId, projectId: SEED.projectId };
    const results = await chunks.search(scope, query('how do support agents issue a refund'), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain('## Refunds');
    expect(results[0]?.text).toContain('support agents');
    expect(results.every((r) => r.featureId === SEED.featureId)).toBe(true);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.distance ?? 0).toBeGreaterThanOrEqual(results[i - 1]?.distance ?? 0);
    }

    const otherResults = await chunks.search(
      { organizationId: SEED.organizationId, projectId: other.projectId },
      query('how do support agents issue a refund'),
      5,
    );
    expect(otherResults.every((r) => r.featureId === other.featureId)).toBe(true);

    // Another Organization's scope sees nothing, even with the right Project id.
    expect(
      await chunks.search(
        { organizationId: crypto.randomUUID(), projectId: SEED.projectId },
        query('refund'),
        5,
      ),
    ).toEqual([]);
    // Feature filter.
    expect(
      await chunks.search({ ...scope, featureId: other.featureId }, query('refund'), 5),
    ).toEqual([]);
    // Vectors of another model are never compared.
    expect(await chunks.search(scope, query('refund', 'embed-other'), 5)).toEqual([]);
  });

  test('search uses the per-dimension HNSW index', async () => {
    await configure();
    await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    await drain();
    const indexes = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'ContentChunk_embedding_hnsw_256'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('USING hnsw');
    expect(indexes[0]?.indexdef).toContain('vector_cosine_ops');

    const vector = `[${fakeEmbedding('refund', 256).join(',')}]`;
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM "ContentChunk"
        WHERE "embeddingModel" = 'embed-a' AND "embeddingDims" = 256
        ORDER BY embedding::vector(256) <=> ${vector}::vector(256) LIMIT 5`;
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'ContentChunk_embedding_hnsw_256',
    );
  });

  test('with no provider configured, actions still succeed and chunks have null embeddings', async () => {
    const attachment = await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    await drain();
    const stored = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: attachment.id });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((c) => c.embedding === null && c.embeddingModel === null)).toBe(true);
    expect(embeddings.calls).toHaveLength(0);

    const scope = { organizationId: SEED.organizationId, projectId: SEED.projectId };
    expect(await chunks.search(scope, query('refund'), 5)).toEqual([]);
  });

  test('a failing provider never fails the action; the stale re-index embeds the chunks later', async () => {
    await configure();
    embeddings.failWith = new EmbeddingError('embeddings.example.test answered HTTP 503: down');
    const attachment = await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    const spec = await asPim<SpecVersionView>('POST', `/features/${SEED.featureId}/spec-versions`, {
      markdown: '# Async checkout\n\nPay without waiting for the webhook.',
      baseVersion: 1,
    });
    expect(spec.status).toBe(201);
    await drain();
    const ref = { source: 'ATTACHMENT' as const, sourceId: attachment.id };
    expect((await chunks.chunksOf(ref)).every((c) => c.embedding === null)).toBe(true);

    embeddings.failWith = null;
    const reindex = await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', {});
    expect(reindex.status).toBe(202);
    // The Attachment and Spec v2 have no vectors yet; nothing else exists.
    expect(reindex.body.queued).toBe(2);
    await drain();
    expect((await chunks.chunksOf(ref)).every((c) => c.embeddingModel === 'embed-a')).toBe(true);

    // Nothing is stale any more; `all` re-indexes everything regardless.
    expect(
      (await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', {})).body.queued,
    ).toBe(0);
    expect(
      (await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', { scope: 'all' })).body
        .queued,
    ).toBe(2);
    await drain();
  });

  test('the stale re-index picks up content embedded with another model, and content never indexed', async () => {
    await configure();
    const attachment = await upload(SEED.featureId, 'handbook.md', HANDBOOK);
    await drain();
    await configure({ ...PROVIDER, model: 'embed-b' });

    // Seeded Spec v1 was written straight to the database, so it was never indexed.
    const res = await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', {
      scope: 'stale',
    });
    expect(res.body.queued).toBe(2);
    await drain();
    const stored = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: attachment.id });
    expect(stored.every((c) => c.embeddingModel === 'embed-b')).toBe(true);
    const v1 = await db.specVersion.findFirstOrThrow({ where: { featureId: SEED.featureId } });
    expect(
      (await chunks.chunksOf({ source: 'SPEC_VERSION', sourceId: v1.id })).length,
    ).toBeGreaterThan(0);
  });

  test('the stale re-index re-cuts Thai chunks counted at four characters per token (0059)', async () => {
    await configure();
    const thai = THAI_SAMPLES.map((s) => s.text).join('\n\n');
    const attachment = await upload(SEED.featureId, 'thai.md', `${thai}\n\n${thai}`);
    await drain();
    const ref = { source: 'ATTACHMENT' as const, sourceId: attachment.id };
    const current = await chunks.chunksOf(ref);
    for (const chunk of current) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNKING.targetTokens);
    }
    // As the index was before ticket 0059: one big chunk, counted at four characters per token.
    const old = `${thai}\n\n${thai}`;
    await db.$executeRaw`DELETE FROM "ContentChunk" WHERE "sourceId" = ${attachment.id}`;
    await chunks.replace(
      { organizationId: SEED.organizationId, projectId: SEED.projectId, featureId: SEED.featureId },
      ref,
      [{ position: 0, text: old, tokenCount: Math.ceil(old.length / 4) }],
      { model: PROVIDER.model, vectors: [fakeEmbedding(old, embeddings.dims)] },
    );

    // The Thai Attachment, and the seeded Spec v1 that was never indexed.
    const res = await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', {
      scope: 'stale',
    });
    expect(res.body.queued).toBe(2);
    await drain();
    expect(await chunks.chunksOf(ref)).toEqual(current);
    // Chunks cut by today's estimate are up to date.
    expect(
      (await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', { scope: 'stale' })).body
        .queued,
    ).toBe(0);
  });

  test('each new Spec Version replaces the Feature’s Spec chunks', async () => {
    await configure();
    const v2 = await asPim<SpecVersionView>('POST', `/features/${SEED.featureId}/spec-versions`, {
      markdown: '# Async checkout\n\n## Goal\nSettle payments by webhook.',
      baseVersion: 1,
    });
    await drain();
    expect(
      (await chunks.chunksOf({ source: 'SPEC_VERSION', sourceId: v2.body.id }))[0]?.text,
    ).toContain('Settle payments by webhook');

    const v3 = await asPim<SpecVersionView>('POST', `/features/${SEED.featureId}/spec-versions`, {
      markdown: '# Async checkout\n\n## Goal\nSettle payments by polling.',
      baseVersion: 2,
    });
    await drain();
    const specChunks = await db.contentChunk.findMany({ where: { source: 'SPEC_VERSION' } });
    expect(specChunks.map((c) => c.sourceId)).toEqual([v3.body.id]);
    expect(specChunks[0]?.text).toContain('polling');
  });

  test('each Decision is indexed with its request and rationale', async () => {
    await configure();
    const { body: draft } = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
      withChoices: true,
    });
    const { body: request } = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.id}/submit`,
      { deciderRole: 'PO' },
    );
    const decided = await asPim<DecideResult>('POST', `/decision-requests/${request.id}/decision`, {
      choiceId: request.choices[1]?.id,
      rationale: 'Polling every ten seconds is cheap enough',
    });
    expect(decided.status).toBe(201);
    await drain();

    const decision = await db.decision.findFirstOrThrow({ where: { requestId: request.id } });
    const stored = await chunks.chunksOf({ source: 'DECISION', sourceId: decision.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toContain('# Decision: Provider has no webhook');
    expect(stored[0]?.text).toContain('Only polling is available.');
    expect(stored[0]?.text).toContain('Choice B');
    expect(stored[0]?.text).toContain('Polling every ten seconds is cheap enough');
    expect(stored[0]?.embeddingModel).toBe('embed-a');
  });

  test('Project Attachments and the latest Brief Version are indexed without a Feature, and retrieved as Project context', async () => {
    await configure();
    const other = await otherProjectFeature();
    const handbook = await upload({ projectId: SEED.projectId }, 'handbook.md', HANDBOOK);
    const decoy = await upload({ projectId: other.projectId }, 'decoy.md', HANDBOOK);
    const brief = `/projects/${SEED.projectId}/brief-versions`;
    const v1 = await asPim<BriefVersionView>('POST', brief, {
      markdown: '# Project Brief\n\n## Business goals\nSettle refunds by webhook.',
      baseVersion: 0,
    });
    const v2 = await asPim<BriefVersionView>('POST', brief, {
      markdown: '# Project Brief\n\n## Business goals\nSettle refunds by polling.',
      baseVersion: 1,
    });
    expect(v2.status).toBe(201);
    await drain();

    const stored = await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: handbook.id });
    expect(stored.length).toBeGreaterThan(1);
    expect(stored.every((c) => c.featureId === null && c.projectId === SEED.projectId)).toBe(true);
    const briefChunks = await db.contentChunk.findMany({ where: { source: 'BRIEF_VERSION' } });
    expect(briefChunks.map((c) => c.sourceId)).toEqual([v2.body.id]);
    expect(briefChunks[0]).toMatchObject({ featureId: null, projectId: SEED.projectId });
    expect(v1.body.id).not.toBe(v2.body.id);

    const retriever = app.get(ContextRetriever);
    const blocks = await retriever.forFeature(
      SEED.featureId,
      'How are refunds settled, and what receipt does the customer get?',
      6_000,
    );
    const ids = blocks.map((b) => b.source.id);
    expect(blocks.find((b) => b.source.id === handbook.id)).toMatchObject({
      scope: 'PROJECT',
      source: { kind: 'ATTACHMENT', title: 'handbook.md' },
    });
    expect(blocks.find((b) => b.source.kind === 'BRIEF_VERSION')).toMatchObject({
      scope: 'PROJECT',
      source: { id: v2.body.id, title: 'Project Brief', version: 2 },
    });
    expect(ids).not.toContain(decoy.id);

    // The other Project's Feature sees its own Project Attachment, never this Project's Brief.
    const otherBlocks = await retriever.forFeature(other.featureId, 'refunds receipt', 6_000);
    expect(otherBlocks.map((b) => b.source.id)).toContain(decoy.id);
    expect(otherBlocks.map((b) => b.source.id)).not.toContain(handbook.id);
    expect(otherBlocks.some((b) => b.source.kind === 'BRIEF_VERSION')).toBe(false);

    // A full re-index covers Project Attachments and each Project's latest Brief Version.
    const res = await asPim<ReindexResult>('POST', '/settings/embeddings/reindex', {
      scope: 'all',
    });
    expect(res.body.queued).toBe(4); // seeded Spec v1, two Project Attachments, Brief v2
    await drain();

    // Removing a Project Attachment removes its chunks.
    expect((await asPim('DELETE', `/attachments/${handbook.id}`)).status).toBe(204);
    await drain();
    expect(await chunks.chunksOf({ source: 'ATTACHMENT', sourceId: handbook.id })).toEqual([]);
  });
});
