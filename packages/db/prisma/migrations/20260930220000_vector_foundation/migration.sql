-- pgvector (ADR 0007). The db image is pgvector/pgvector; creating the extension
-- needs a superuser, which the docker compose and CI databases are.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "ChunkSource" AS ENUM ('ATTACHMENT', 'SPEC_VERSION', 'DECISION');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'EMBEDDINGS';

-- CreateTable
CREATE TABLE "ContentChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "source" "ChunkSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector,
    "embeddingModel" TEXT,
    "embeddingDims" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentChunk_organizationId_projectId_featureId_idx" ON "ContentChunk"("organizationId", "projectId", "featureId");

-- CreateIndex
CREATE INDEX "ContentChunk_featureId_idx" ON "ContentChunk"("featureId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentChunk_source_sourceId_position_key" ON "ContentChunk"("source", "sourceId", "position");

-- AddForeignKey
ALTER TABLE "ContentChunk" ADD CONSTRAINT "ContentChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentChunk" ADD CONSTRAINT "ContentChunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentChunk" ADD CONSTRAINT "ContentChunk_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The column has no fixed dimension, so the model can change (re-index, never mix).
-- HNSW needs one, so ContentChunkRepository creates one partial index per
-- dimension in use, the first time it stores vectors of that dimension:
--   CREATE INDEX "ContentChunk_embedding_hnsw_<N>" ON "ContentChunk"
--   USING hnsw ((embedding::vector(<N>)) vector_cosine_ops) WHERE "embeddingDims" = <N>;
