---
status: done
depends-on: [0023]
slice: retrieval
---

# 0036: Vector foundation: pgvector, chunks, EmbeddingPort, indexing

## Goal
All long content is chunked and embedded as it changes, so AI workflows can retrieve only what's relevant (ADR 0007).

## Scope
- **Postgres image:** `pgvector/pgvector:pg17` in `docker-compose.yml` and in the CI service; the README is updated.
- **Migration:**
  - `CREATE EXTENSION IF NOT EXISTS vector`.
  - `ContentChunk`:
    - id, organizationId, projectId, featureId?;
    - source: ATTACHMENT | SPEC_VERSION | DECISION (later BRIEF_VERSION), and sourceId;
    - position, text, tokenCount;
    - `embedding Unsupported("vector")?`, `embeddingModel`, createdAt.
  - An HNSW index on the embedding (cosine).
  - Dimensions are not fixed in the column type, so the model can change; the index is per model dimension, or created when the first model is configured. Choose one approach and document it.
- **`EmbeddingPort`** `embed(texts[]) → number[][]`:
  - An OpenAI-compatible adapter (`POST {baseUrl}/embeddings`), with URL, key and model set by an Admin in an `EMBEDDINGS` `OrgIntegration`. The key is encrypted with `VORASAAN_SECRET_KEY` and never returned.
  - Admin settings endpoints, with a test-connection call that reports the model's dimension.
  - A deterministic `FakeEmbeddingPort` for tests.
  - With no provider configured, everything still works: chunks are stored with a null embedding, and retrieval falls back (0037).
- **Chunker:** a Markdown/heading-aware split with overlap and a target size, in one tested module.
- **Indexing:**
  - Index on Attachment create or refresh (its Snapshot), each new Spec Version, and each Decision (with its rationale).
  - Re-indexing a source replaces its chunks.
  - It runs after the transaction commits and never fails the user's action. A failure is logged and retried by the re-index command.
  - An Admin endpoint re-indexes everything, or everything embedded with another model.
- **Search:** a single repository class with `search(scope, queryEmbedding, k)` in raw SQL, always filtered by organization and project. No cross-Project leaks.

## Acceptance criteria (test first, real Postgres with pgvector + `FakeEmbeddingPort`)
- [x] Attaching a Markdown file creates chunks with embeddings; refreshing it replaces them.
- [x] Search returns the relevant chunk first, and never returns chunks from another Project.
- [x] With no provider configured, actions still succeed and chunks have null embeddings.
- [x] CI runs against the pgvector image.

## Notes (as built)
- **Dimension and index:** `embedding` is an unconstrained `vector`, with `embeddingModel` and `embeddingDims` on each chunk. `ContentChunkRepository` creates one partial HNSW index per dimension the first time it stores vectors of that size: `USING hnsw ((embedding::vector(N)) vector_cosine_ops) WHERE "embeddingDims" = N`. Search casts and filters the same way (plus the model), so the planner uses it. Above 2,000 dimensions (HNSW's limit for `vector`) search is an exact scan. Prisma ignores these expression indexes, so `migrate dev` sees no drift.
- **Chunker:** `retrieval/chunker.ts`, about 400 tokens per chunk (4 characters per token), 50 tokens of overlap, sections at headings outside code fences, the heading repeated on each piece of a long section.
- **Indexing:** jobs run one at a time after the change commits and read the source as it is then. Only a Feature's latest Spec Version keeps chunks. A failed embedding call stores chunks without vectors; `POST /settings/embeddings/reindex` (`stale` by default, or `all`) fixes them, and is also how a new model takes effect.
