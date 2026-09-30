-- Keyword fallback for retrieval (ticket 0037): without an embeddings provider, the
-- ContextRetriever ranks chunks with Postgres full-text search. This GIN index on the
-- same expression the query uses keeps that fast: on a Project of 5,000 chunks, a query
-- went from ~900 ms (to_tsvector on every row) to ~160 ms, for ~0.3 ms more per chunk
-- written. Prisma ignores expression indexes, so migrate dev sees no drift.
CREATE INDEX "ContentChunk_text_fts_idx" ON "ContentChunk" USING gin (to_tsvector('simple', "text"));
