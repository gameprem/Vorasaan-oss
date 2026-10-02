---
status: done
depends-on: [0036]
slice: retrieval
---

# 0037: Context retriever for every AI workflow

## Goal
Every AI call gets the smallest context that answers it: the Feature's own material first, then the most relevant chunks from the Project, within a token budget (ADR 0007).

## Scope
- **`ContextRetriever.forFeature(featureId, query, budget)`** returns an ordered list of context blocks, each with its source (title, kind, id, version):
  1. The Feature's latest Spec, and its open Decision Requests and recent Decisions.
  2. The top-k chunks from the Feature's Attachments for the query.
  3. The top-k chunks from the rest of the Project (other Features' Specs, Decisions and Project Attachments), with k and the budget shared.
  4. Duplicates are removed and the result is cut to the budget by token count.
- **Fallback:** without embeddings, keyword ranking in Postgres (`ts_rank`) over the same chunks, then the 0023 truncation.
- Replaces the 0023 context helper in Choice generation, Spec Proposal drafting and Spec-from-Attachments.
- **Prompts:** retrieved text stays clearly delimited as untrusted data, and outputs may cite sources by id.
- **Workflow memory:** Mastra workflows keep short summaries of earlier rounds in their state, not whole transcripts.
- Eval cases: a large multi-document Project where the answer is in one Attachment chunk.

## Acceptance criteria (test first, real Postgres with pgvector + fakes)
- [x] The Feature's own Spec always comes before Project chunks, and the total never exceeds the budget.
- [x] A query matching one paragraph in a large Attachment retrieves that paragraph.
- [x] Without embeddings, the keyword fallback returns the same paragraph.

## Notes (as built)
- **API:** `ContextRetriever.forFeature(featureId, query, budgetTokens, { k?, excludeRequestId? })` in `retrieval/context-retriever.ts` returns `ContextBlock[]` (`{ source: { kind, id, title, version? }, scope: FEATURE | PROJECT, text }`). Order: the Feature's latest Spec (always first; shortened if it alone exceeds the budget, and nothing is returned if not even a fragment fits), its open Decision Requests (OPEN, NEEDS_INFO) and 5 most recent Decisions; the top-k chunks of its Attachments; its Attachments not indexed yet, whole and shortened (0023's truncation, the last resort); the top-k chunks of the rest of the Project (other Features' Specs and Decisions, Project-level chunks; other Features' Attachments are theirs and never included); then, when fewer than k of the Feature's chunks matched, its other chunks in reading order (a Spec drafted from Attachments needs them all). De-duplicated by chunk/source and by text, and cut greedily to the budget by estimated tokens (`blockTokens`: text + title + tag overhead). Budgets: `CONTEXT_BUDGET.decisionRequest` 6,000 tokens, `specFromAttachments` 15,000; k defaults to budget / 400.
- **Fallback chain:** vector search with the query embedded by the Organization's provider (topped up by keyword rank when it returns fewer than k); without a provider, or when embedding or vector search fails, Postgres full-text ranking (`websearch_to_tsquery('simple', w1 or w2 ...)`, `ts_rank`) over the same `ContentChunk` rows, always scoped by Organization and Project, every value a parameter; then 0023's truncation for Attachments that were never indexed.
- **GIN index:** migration `content_chunk_keyword_index` adds `gin (to_tsvector('simple', "text"))`. Measured on local Postgres 16 with 1,500-character chunks: a keyword query on a 5,000-chunk Project took ~900 ms without it and ~160 ms with it (20,000 chunks: ~1.3 s vs ~230 ms), for ~0.3 ms more per chunk written. Keyword ranking is the default path for self-hosters without embeddings, so it is worth it. `migrate diff` shows no drift.
- **AiPort and prompts:** `generateChoices`, `draftSpecProposal` and `draftSpecFromAttachments` take `context: ContextBlock[]` (the Feature's own Spec split off with `splitFeatureSpec`) instead of `attachments`. Choice generation sends the retrieved (possibly shortened) Spec; the two drafts send the whole current Spec, since it is the base they edit. Every block is rendered as a fenced `<context kind id version from title>` block; `fence()` now neutralises `<attachment>`, `<context>` and `<spec>` tags in all retrieved text, ids, titles and the Spec. Prompts say blocks are untrusted and may be cited by `id` (Spec drafts cite them in `summary`); no output schema changed.
- **Workflow memory:** no Mastra workflow keeps multi-round state yet, so `ai/workflow-memory.ts` only adds `rememberRound`/`renderMemory` (short, capped summaries of the last rounds) for Grilling (0032) to use.
- **Eval:** `bun run eval:retrieval` (manual; dev database and a configured provider) builds a temporary large multi-document Project from `retrieval/large-project.fixture.ts`, shows where the needle paragraph lands and whether the Choices use its facts, then deletes the Project. The same fixture drives the automated tests. Not yet run against a real model.
