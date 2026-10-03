---
status: todo
depends-on: [0073]
slice: performance
---

# 0074: Database optimization

## Goal
The hot endpoints measured in 0073 get faster on a large Organization, and stay that way.

## Scope
Driven by the 0073 baseline, not by guesses:
- **Missing indexes** found in `pg_stat_statements` and the slow query log, added by migration.
- **Heavy queries** rewritten or split, for example the Inbox and Decision Lead Time aggregates.
- **N+1** removed where 0073 found it.
- **Connection pool** sizing for the server and the background jobs, documented with the reasoning.
- **pgvector:** HNSW `ef_search` tuned for recall against latency on the 200,000-chunk dataset, using the retrieval eval set (`bun run eval:retrieval`) to check recall holds.
- **Query-count budgets:** each measured endpoint gets a budget, checked in tests.

## Acceptance criteria (test first, real Postgres)
- [ ] Every endpoint measured in 0073 has a p95 no worse than its baseline, and the targeted ones are better.
- [ ] Each measured endpoint has a query-count budget, and a test fails when a request exceeds it.
- [ ] Retrieval recall on the eval set doesn't drop after the `ef_search` change.
- [ ] A before and after report is recorded in this ticket's Decisions.
