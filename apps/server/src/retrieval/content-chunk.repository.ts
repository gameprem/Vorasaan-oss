import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { type ChunkSource, Prisma, type PrismaClient } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import type { TextChunk } from './chunker.ts';
import { assertVectors, MAX_EMBEDDING_DIMS } from './embedding.port.ts';

/** Where chunks belong. Every read and write is filtered by Organization and Project. */
export type ChunkScope = { organizationId: string; projectId: string; featureId: string | null };

/**
 * Which chunks a search looks at, always inside one Project of one Organization.
 * - `featureId`: only that Feature's chunks.
 * - `outsideFeatureId`: the rest of the Project as seen from that Feature: other
 *   Features' Specs and Decisions, and Project-level chunks (no Feature). Other
 *   Features' Attachments belong to them, so they are left out.
 * - `projectLevel`: only Project-level chunks (no Feature): the Brief and
 *   Project Attachments.
 * - `sources`: only chunks cut from these kinds of source.
 */
export type SearchScope = {
  organizationId: string;
  projectId: string;
  featureId?: string;
  outsideFeatureId?: string;
  projectLevel?: boolean;
  sources?: ChunkSource[];
};

export type ChunkSourceRef = { source: ChunkSource; sourceId: string };

export type ChunkEmbeddings = { model: string; vectors: number[][] };

export type ChunkMatch = {
  id: string;
  source: ChunkSource;
  sourceId: string;
  featureId: string | null;
  position: number;
  text: string;
  tokenCount: number;
  /** Cosine distance: 0 is the same direction, 2 the opposite. */
  distance: number;
};

export type KeywordMatch = Omit<ChunkMatch, 'distance'> & {
  /** Postgres `ts_rank` (length-normalized): higher is more relevant. */
  rank: number;
};

export type StoredChunk = {
  position: number;
  text: string;
  tokenCount: number;
  featureId: string | null;
  projectId: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  embeddingDims: number | null;
};

/** HNSW indexes `vector` columns of at most 2,000 dimensions; larger ones are scanned exactly. */
export const HNSW_MAX_DIMS = 2_000;
export const MAX_SEARCH_K = 100;
/**
 * Vector search ranks a scope of up to this many chunks exactly, and uses the HNSW
 * index only above it (ticket 0074; see `search`). Ranking 20,000 chunks exactly takes
 * tens of milliseconds; a Project-level scope is usually a few thousand.
 */
export const EXACT_SEARCH_MAX_CHUNKS = 20_000;

/**
 * How chunks that rank alike are ordered: the most recently indexed source first, then its
 * reading order, then the text byte by byte (`COLLATE "C"`, so no locale can reorder it),
 * and the id only between chunks of the same text. Without it (before this fix, ticket 0076)
 * a tie was broken by random ids or by the order rows happened to lie on disk, so the same
 * search on the same data could return different chunks from one database to the next; the
 * fake embeddings put every chunk that shares no word with the query at exactly distance 1.
 */
function tieBreak(table: string): Prisma.Sql {
  const t = Prisma.raw(table);
  return Prisma.sql`${t}."createdAt" DESC, ${t}."position", ${t}."text" COLLATE "C", ${t}."id"`;
}

/** A Thai character, as a Postgres regular expression. */
const THAI_CHARACTER = '[\u0E00-\u0E7F]';
/** Below this many Thai characters, a chunk's old and new estimates may round alike. */
const OLD_THAI_ESTIMATE_MIN_CHARS = 8;

/**
 * The only code that reads or writes ContentChunk (ADR 0007): Prisma has no vector
 * type, so this is raw SQL, with every value passed as a parameter. The one
 * exception is the vector dimension, which Postgres needs as a literal in
 * `vector(N)`; it is always a checked integer, never text from a request.
 *
 * Indexing: one partial HNSW index per dimension in use, created the first time
 * vectors of that dimension are stored, and queried with the same expression
 * and predicate so the planner can use it:
 *   ((embedding::vector(N)) vector_cosine_ops) WHERE "embeddingDims" = N
 */
@Injectable()
export class ContentChunkRepository {
  private readonly logger = new Logger(ContentChunkRepository.name);
  private readonly indexes = new Map<number, Promise<void>>();
  /** Where `search` switches from exact ranking to the HNSW index (tests lower it). */
  exactSearchMaxChunks = EXACT_SEARCH_MAX_CHUNKS;

  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  /** Replaces all chunks of one source, atomically. `embeddings` null stores them unembedded. */
  async replace(
    scope: ChunkScope,
    ref: ChunkSourceRef,
    chunks: TextChunk[],
    embeddings: ChunkEmbeddings | null,
  ): Promise<void> {
    assertScope(scope);
    if (embeddings) {
      assertVectors(embeddings.vectors, chunks.length);
      const dims = embeddings.vectors[0]?.length;
      if (dims) await this.ensureIndex(dims);
    }
    const rows = chunks.map((chunk, i) => {
      const vector = embeddings?.vectors[i];
      return Prisma.sql`(
        ${randomUUID()}, ${scope.organizationId}, ${scope.projectId}, ${scope.featureId}::text,
        ${ref.source}::"ChunkSource", ${ref.sourceId}, ${chunk.position}::int, ${chunk.text},
        ${chunk.tokenCount}::int, ${vector ? toVectorLiteral(vector) : null}::vector,
        ${vector ? embeddings?.model : null}::text, ${vector ? vector.length : null}::int
      )`;
    });
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "ContentChunk"
        WHERE "source" = ${ref.source}::"ChunkSource" AND "sourceId" = ${ref.sourceId}`;
      if (!rows.length) return;
      await tx.$executeRaw`
        INSERT INTO "ContentChunk" (
          "id", "organizationId", "projectId", "featureId", "source", "sourceId", "position",
          "text", "tokenCount", "embedding", "embeddingModel", "embeddingDims"
        ) VALUES ${Prisma.join(rows)}`;
    });
  }

  async deleteSource(ref: ChunkSourceRef): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "ContentChunk"
      WHERE "source" = ${ref.source}::"ChunkSource" AND "sourceId" = ${ref.sourceId}`;
  }

  /** Only a Feature's latest Spec Version stays in the index. */
  async deleteOtherSpecVersions(featureId: string, keepId: string): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "ContentChunk"
      WHERE "source" = 'SPEC_VERSION' AND "featureId" = ${featureId} AND "sourceId" <> ${keepId}`;
  }

  /** Only a Project's latest Brief Version stays in the index. */
  async deleteOtherBriefVersions(projectId: string, keepId: string): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "ContentChunk"
      WHERE "source" = 'BRIEF_VERSION' AND "projectId" = ${projectId} AND "sourceId" <> ${keepId}`;
  }

  /**
   * The `k` chunks nearest to `embedding`, among those embedded by the same model,
   * in one Project of one Organization (and one Feature, when given).
   *
   * A scope of up to `exactSearchMaxChunks` chunks is ranked exactly, in one statement
   * (ticket 0074): pgvector filters HNSW candidates only after the index scan, so when
   * the scope is a small share of the Organization's chunks, most of the `ef_search`
   * candidates fall outside it and the nearest chunks in it are missed. Only a larger
   * scope goes through the HNSW index.
   *
   * In the exact ranking, every chunk as near as the k-th is a candidate and `tieBreak`
   * picks among them, so the same data always gives the same chunks. The HNSW path is
   * approximate and orders by distance only: the index can't sort by anything else.
   */
  async search(
    scope: SearchScope,
    query: { model: string; embedding: number[] },
    k: number,
  ): Promise<ChunkMatch[]> {
    assertScope(scope);
    assertVectors([query.embedding], 1);
    const dims = Prisma.raw(String(checkedDims(query.embedding.length)));
    const limit = Math.min(Math.max(1, Math.floor(k) || 1), MAX_SEARCH_K);
    const vector = toVectorLiteral(query.embedding);
    const exact = await this.db.$queryRaw<(ChunkMatch & { scoped: bigint })[]>`
      WITH scoped AS MATERIALIZED (
        SELECT "id", "embedding"::vector(${dims}) <=> ${vector}::vector(${dims}) AS "distance"
        FROM "ContentChunk"
        WHERE ${scopeCondition(scope)}
          AND "embeddingModel" = ${query.model}
          AND "embeddingDims" = ${dims}
        LIMIT ${this.exactSearchMaxChunks + 1}
      ), cutoff AS (
        SELECT "distance" FROM scoped ORDER BY "distance" OFFSET ${limit - 1} LIMIT 1
      ), nearest AS (
        SELECT "id", "distance" FROM scoped
        WHERE NOT EXISTS (SELECT 1 FROM cutoff) OR "distance" <= (SELECT "distance" FROM cutoff)
      )
      SELECT c."id", c."source", c."sourceId", c."featureId", c."position", c."text",
             c."tokenCount", n."distance", (SELECT count(*) FROM scoped) AS "scoped"
      FROM nearest n JOIN "ContentChunk" c ON c."id" = n."id"
      ORDER BY n."distance", ${tieBreak('c')}
      LIMIT ${limit}`;
    if (Number(exact[0]?.scoped ?? 0) <= this.exactSearchMaxChunks) {
      return exact.map(({ scoped: _, ...row }) => ({ ...row, distance: Number(row.distance) }));
    }
    // HNSW returns ef_search candidates before the Organization/Project filter:
    // widen it so the scope still gets its k results.
    const efSearch = String(Math.min(1_000, Math.max(100, limit * 10)));
    const [, rows] = await this.db.$transaction([
      this.db.$queryRaw`SELECT set_config('hnsw.ef_search', ${efSearch}, true)`,
      this.db.$queryRaw<ChunkMatch[]>`
        SELECT "id", "source", "sourceId", "featureId", "position", "text", "tokenCount",
               "embedding"::vector(${dims}) <=> ${vector}::vector(${dims}) AS "distance"
        FROM "ContentChunk"
        WHERE ${scopeCondition(scope)}
          AND "embeddingModel" = ${query.model}
          AND "embeddingDims" = ${dims}
        ORDER BY "embedding"::vector(${dims}) <=> ${vector}::vector(${dims})
        LIMIT ${limit}`,
    ]);
    return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  }

  /**
   * Keyword ranking for when there are no embeddings (ADR 0007): Postgres full-text
   * search over the same chunks, with the 'simple' configuration so no language is
   * assumed. The query's words are OR-ed, so a chunk matching more of them ranks higher.
   * Chunks with or without vectors are both searched.
   *
   * The migration `content_chunk_keyword_index` adds a GIN index on exactly
   * `to_tsvector('simple', "text")`: keep the expression identical so it is used.
   */
  async keywordSearch(scope: SearchScope, text: string, k: number): Promise<KeywordMatch[]> {
    assertScope(scope);
    const words = keywordTerms(text);
    if (!words.length) return [];
    const limit = Math.min(Math.max(1, Math.floor(k) || 1), MAX_SEARCH_K);
    // websearch_to_tsquery never fails on user text; "or" makes it a disjunction.
    const tsquery = words.join(' or ');
    const rows = await this.db.$queryRaw<KeywordMatch[]>`
      SELECT "id", "source", "sourceId", "featureId", "position", "text", "tokenCount",
             ts_rank(to_tsvector('simple', "text"), q, 1) AS "rank"
      FROM "ContentChunk", websearch_to_tsquery('simple', ${tsquery}) AS q
      WHERE ${scopeCondition(scope)}
        AND to_tsvector('simple', "text") @@ q
      ORDER BY "rank" DESC, ${tieBreak('"ContentChunk"')}
      LIMIT ${limit}`;
    return rows.map((row) => ({ ...row, rank: Number(row.rank) }));
  }

  /**
   * Up to `k` chunks of the scope in reading order (most recently indexed source
   * first), skipping `exceptIds`: the filler when ranking found fewer than `k`.
   */
  async inOrder(scope: SearchScope, k: number, exceptIds: string[] = []): Promise<KeywordMatch[]> {
    assertScope(scope);
    const limit = Math.min(Math.max(1, Math.floor(k) || 1), MAX_SEARCH_K);
    const except = exceptIds.length
      ? Prisma.sql`AND "id" NOT IN (${Prisma.join(exceptIds)})`
      : Prisma.empty;
    return this.db.$queryRaw<KeywordMatch[]>`
      SELECT "id", "source", "sourceId", "featureId", "position", "text", "tokenCount",
             0::float8 AS "rank"
      FROM "ContentChunk"
      WHERE ${scopeCondition(scope)} ${except}
      ORDER BY "createdAt" DESC, "sourceId", "position"
      LIMIT ${limit}`;
  }

  /** Which of these sources have any chunk at all (indexed, with or without vectors). */
  async indexedSourceIds(
    organizationId: string,
    source: ChunkSource,
    sourceIds: string[],
  ): Promise<Set<string>> {
    if (!sourceIds.length) return new Set();
    const rows = await this.db.$queryRaw<{ sourceId: string }[]>`
      SELECT DISTINCT "sourceId" FROM "ContentChunk"
      WHERE "organizationId" = ${organizationId}
        AND "source" = ${source}::"ChunkSource"
        AND "sourceId" IN (${Prisma.join(sourceIds)})`;
    return new Set(rows.map((r) => r.sourceId));
  }

  /** One source's chunks in order, with their vectors (for tests and diagnostics). */
  async chunksOf(ref: ChunkSourceRef): Promise<StoredChunk[]> {
    const rows = await this.db.$queryRaw<
      (Omit<StoredChunk, 'embedding'> & { embedding: string | null })[]
    >`
      SELECT "position", "text", "tokenCount", "featureId", "projectId",
             "embedding"::text AS "embedding", "embeddingModel", "embeddingDims"
      FROM "ContentChunk"
      WHERE "source" = ${ref.source}::"ChunkSource" AND "sourceId" = ${ref.sourceId}
      ORDER BY "position"`;
    return rows.map((row) => ({
      ...row,
      embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : null,
    }));
  }

  /**
   * Sources of the Organization whose chunks were all embedded by `model` (or, when
   * `model` is null, indexed at all), as `SOURCE:id` keys. Everything else is stale,
   * including Thai chunks still sized and counted at four characters per token
   * (before ticket 0059): re-indexing cuts them again by the script-aware estimate.
   */
  async upToDateSources(organizationId: string, model: string | null): Promise<Set<string>> {
    const condition = model
      ? Prisma.sql`bool_and("embeddingModel" IS NOT DISTINCT FROM ${model}::text)`
      : Prisma.sql`true`;
    // With this many Thai characters, today's estimate is always above the old one.
    const countedAsLatin = Prisma.sql`(
      char_length("text") - char_length(regexp_replace("text", ${THAI_CHARACTER}, '', 'g'))
        >= ${OLD_THAI_ESTIMATE_MIN_CHARS}::int
      AND "tokenCount" <= ceil(char_length("text") / 4.0)
    )`;
    const rows = await this.db.$queryRaw<{ source: ChunkSource; sourceId: string }[]>`
      SELECT "source", "sourceId" FROM "ContentChunk"
      WHERE "organizationId" = ${organizationId}
      GROUP BY "source", "sourceId"
      HAVING ${condition} AND bool_and(NOT ${countedAsLatin})`;
    return new Set(rows.map((r) => sourceKey(r)));
  }

  /**
   * Creates the partial HNSW index for `dims` once per process. A failure is only
   * logged: without the index, search is exact and slower, but still correct.
   */
  private ensureIndex(dims: number): Promise<void> {
    const n = checkedDims(dims);
    if (n > HNSW_MAX_DIMS) return Promise.resolve();
    let pending = this.indexes.get(n);
    if (!pending) {
      pending = this.db.$executeRawUnsafe(hnswIndexSql(n)).then(
        () => undefined,
        (error: Error) => {
          this.indexes.delete(n);
          this.logger.warn(`Could not create the HNSW index for ${n} dimensions: ${error.message}`);
        },
      );
      this.indexes.set(n, pending);
    }
    return pending;
  }
}

/**
 * The partial HNSW index for one dimension. Bulk loads (the large Organization of ticket
 * 0073) create it after inserting, with the same statement, so search plans stay the same.
 */
export function hnswIndexSql(dims: number): string {
  const n = checkedDims(dims);
  return (
    `CREATE INDEX IF NOT EXISTS "ContentChunk_embedding_hnsw_${n}" ON "ContentChunk" ` +
    `USING hnsw ((embedding::vector(${n})) vector_cosine_ops) WHERE "embeddingDims" = ${n}`
  );
}

export function sourceKey(ref: ChunkSourceRef): string {
  return `${ref.source}:${ref.sourceId}`;
}

/** `vector(N)` needs N as a literal in the SQL, so it must be a checked integer. */
function checkedDims(dims: number): number {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_EMBEDDING_DIMS) {
    throw new Error(`Invalid embedding dimension: ${dims}`);
  }
  return dims;
}

/** pgvector's text format, passed as a parameter and cast: "[0.1,0.2,...]". */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** The WHERE conditions of a SearchScope; every value is a parameter. */
function scopeCondition(scope: SearchScope): Prisma.Sql {
  const conditions = [
    Prisma.sql`"organizationId" = ${scope.organizationId}`,
    Prisma.sql`"projectId" = ${scope.projectId}`,
  ];
  if (scope.featureId) conditions.push(Prisma.sql`"featureId" = ${scope.featureId}`);
  if (scope.outsideFeatureId) {
    conditions.push(
      Prisma.sql`"featureId" IS DISTINCT FROM ${scope.outsideFeatureId}::text`,
      Prisma.sql`("source" <> 'ATTACHMENT' OR "featureId" IS NULL)`,
    );
  }
  if (scope.projectLevel) conditions.push(Prisma.sql`"featureId" IS NULL`);
  if (scope.sources) {
    if (!scope.sources.length) return Prisma.sql`false`;
    conditions.push(
      Prisma.sql`"source" IN (${Prisma.join(scope.sources.map((s) => Prisma.sql`${s}::"ChunkSource"`))})`,
    );
  }
  return Prisma.join(conditions, ' AND ');
}

/** Words that carry no meaning in a keyword query (the 'simple' config keeps them all). */
const KEYWORD_STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from has have how if in into is it its of on or our should that the their then there these this to was we what when where which who why will with you your'.split(
    ' ',
  ),
);
const MAX_KEYWORD_TERMS = 32;

/** The distinct meaningful words of a query, lower-cased, at most 32. */
export function keywordTerms(text: string): string[] {
  const words = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (KEYWORD_STOP_WORDS.has(word) || (word.length < 2 && !/\d/.test(word))) continue;
    words.add(word);
    if (words.size === MAX_KEYWORD_TERMS) break;
  }
  return [...words];
}

function assertScope(scope: { organizationId: string; projectId: string }) {
  if (!scope.organizationId || !scope.projectId) {
    throw new Error('Chunks are always scoped to an Organization and a Project');
  }
}
