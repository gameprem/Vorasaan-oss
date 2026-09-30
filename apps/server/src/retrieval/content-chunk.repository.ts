import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { type ChunkSource, Prisma, type PrismaClient } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import type { TextChunk } from './chunker.ts';
import { assertVectors, MAX_EMBEDDING_DIMS } from './embedding.port.ts';

/** Where chunks belong. Every read and write is filtered by Organization and Project. */
export type ChunkScope = { organizationId: string; projectId: string; featureId: string | null };

export type SearchScope = { organizationId: string; projectId: string; featureId?: string };

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

  /**
   * The `k` chunks nearest to `embedding`, among those embedded by the same model,
   * in one Project of one Organization (and one Feature, when given).
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
    const feature = scope.featureId
      ? Prisma.sql`AND "featureId" = ${scope.featureId}`
      : Prisma.empty;
    // HNSW returns ef_search candidates before the Organization/Project filter:
    // widen it so a small Project still gets its k results.
    const efSearch = String(Math.min(1_000, Math.max(100, limit * 10)));
    const [, rows] = await this.db.$transaction([
      this.db.$queryRaw`SELECT set_config('hnsw.ef_search', ${efSearch}, true)`,
      this.db.$queryRaw<ChunkMatch[]>`
        SELECT "id", "source", "sourceId", "featureId", "position", "text", "tokenCount",
               "embedding"::vector(${dims}) <=> ${vector}::vector(${dims}) AS "distance"
        FROM "ContentChunk"
        WHERE "organizationId" = ${scope.organizationId}
          AND "projectId" = ${scope.projectId}
          ${feature}
          AND "embeddingModel" = ${query.model}
          AND "embeddingDims" = ${dims}
        ORDER BY "embedding"::vector(${dims}) <=> ${vector}::vector(${dims})
        LIMIT ${limit}`,
    ]);
    return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
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
   * `model` is null, indexed at all), as `SOURCE:id` keys. Everything else is stale.
   */
  async upToDateSources(organizationId: string, model: string | null): Promise<Set<string>> {
    const condition = model
      ? Prisma.sql`bool_and("embeddingModel" IS NOT DISTINCT FROM ${model}::text)`
      : Prisma.sql`true`;
    const rows = await this.db.$queryRaw<{ source: ChunkSource; sourceId: string }[]>`
      SELECT "source", "sourceId" FROM "ContentChunk"
      WHERE "organizationId" = ${organizationId}
      GROUP BY "source", "sourceId"
      HAVING ${condition}`;
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
      pending = this.db
        .$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "ContentChunk_embedding_hnsw_${n}" ON "ContentChunk" ` +
            `USING hnsw ((embedding::vector(${n})) vector_cosine_ops) WHERE "embeddingDims" = ${n}`,
        )
        .then(
          () => undefined,
          (error: Error) => {
            this.indexes.delete(n);
            this.logger.warn(
              `Could not create the HNSW index for ${n} dimensions: ${error.message}`,
            );
          },
        );
      this.indexes.set(n, pending);
    }
    return pending;
  }
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
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function assertScope(scope: { organizationId: string; projectId: string }) {
  if (!scope.organizationId || !scope.projectId) {
    throw new Error('Chunks are always scoped to an Organization and a Project');
  }
}
