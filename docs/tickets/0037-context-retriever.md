---
status: todo
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
- [ ] The Feature's own Spec always comes before Project chunks, and the total never exceeds the budget.
- [ ] A query matching one paragraph in a large Attachment retrieves that paragraph.
- [ ] Without embeddings, the keyword fallback returns the same paragraph.
