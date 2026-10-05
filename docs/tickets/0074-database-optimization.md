---
status: done
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
- [x] Every endpoint measured in 0073 has a p95 no worse than its baseline, and the targeted ones are better.
- [x] Each measured endpoint has a query-count budget, and a test fails when a request exceeds it.
- [x] Retrieval recall on the eval set doesn't drop after the `ef_search` change.
- [x] A before and after report is recorded in this ticket's Decisions.

## Decisions
- **Driven by the 0073 baseline.** `pg_stat_statements` still can't be loaded on the measuring server, so the evidence is the benchmark's per-statement timings, `EXPLAIN (ANALYZE, BUFFERS)` and `pg_stat_user_tables`. Every change keeps the answers the same: a script dumped 8 people's Inboxes, Decision Lead Time for 12 Projects (and a custom range), and everything a full escalation run writes (history entries with names and times, Notifications, Recipients, steps) on the large dataset, before and after, and the two dumps are byte-identical.
- **The escalation job is batched** (`EscalationJob`, `ESCALATION_BATCH_SIZE` 200). Each batch is one transaction: one `FOR UPDATE SKIP LOCKED` over its requests (still a row lock per request, so several instances share the work), one re-read of them under the locks with their Recipients, Team and Organization, the calendar once per Organization per run, one read each of the active Delegations (`delegationsActiveAt` + `delegatesOf`) and Tech Leads, then one insert each for new Recipients, Notifications (`NotificationsService.notifyAll`, an `INSERT ... SELECT FROM unnest(...)`) and history entries (names read once, sorted by the database as before), and one `UPDATE ... FROM unnest` for the new steps. A batch that fails is retried one request at a time, so one bad request is logged and the rest still escalate (tested). Statements per run don't grow with the requests (tested with 3 and 12). The chat apps get one change's signals together: `ChatCardsService.deliver` looks up the Organization and its enabled chat apps once per batch of signals instead of per signal.
- **Notifications are read back only for people listening**: `publish` re-read every Notification it pushed; it now reads only those whose person has a `GET /events` stream open in this process (`EventBus.listening`), which is all it ever sent to. The job (and every other write) skips the read when nobody is connected.
- **The Inbox stays a full list.** Paging it would change the contract that the web Inbox (its group counts), the sidebar's count and the CLI read; that is a product change for its own ticket. Instead its two heavy reads are one statement each with only what the item shows (`requestsToDecide`, `proposalsToApprove`: joins for the Feature, the Raiser, the onBehalfOf person and the Decision's request, built as JSON), instead of the full rows plus four `IN`-list look-ups each. 22 statements become 15.
- **Decision Lead Time** reads each request's timeline in one statement (recipients, messages, `DELEGATES_ADDED` history and Decider changes as array/JSON sub-selects, times as epoch milliseconds so no time zone is involved), 17 statements become 12. Its app time was mostly working-time arithmetic: `working-time.ts` now keeps each calendar's working hours per local date for as long as that calendar object lives (one request or job run), about 10x faster for `workingTimeBetween`.
- **No index added.** With the hot paths rewritten, `EXPLAIN` and `pg_stat_user_tables` over a benchmark run show no sequential scan of a large table by the app (the only ones are the benchmark's own reset of its snapshot). A covering `RequestRecipient (userId, requestId)` index for the Inbox was tried: the planner kept the existing `userId` index and the statement took the same 9-10 ms, so it was not added.
- **Vector search ranks small scopes exactly** (`ContentChunkRepository.search`, `EXACT_SEARCH_MAX_CHUNKS` 20,000). pgvector 0.6 filters HNSW candidates after the index scan. On the 200,000-chunk dataset (50 Projects) the planner never picks the HNSW index for the app's scoped searches (the `(organizationId, projectId, featureId)` index plus an exact sort wins), so `ef_search` has no effect there: recall@30 against an exact ranking is 0.999 (ties) at every `ef_search` from 40 to 1,000. On the medium dataset (5 Projects, 20,000 chunks) the planner does pick HNSW for the Project-level scope, and recall@30 collapsed to 0.13 at the app's `ef_search` 300 (0.33 even at 1,000), because a Project-level scope is about 1% of the index. So instead of tuning `ef_search`, a scope of up to 20,000 chunks is ranked exactly in one statement (distances over the scope, materialized, then the top k joined back), which also drops the `set_config` transaction (25 statements instead of 29 for retrieval). Only a larger scope uses the HNSW index, with `ef_search` as before. Recall@30 over 41 queries and 20 Projects, before → after: large 0.999 → 0.999, medium Project scope 0.134 → 1.000, Feature Attachments 1.000 → 1.000. `bun run eval:retrieval` (with `VORASAAN_AI=fake` and fake embeddings configured, so ranking is by vector) finds the needle at block 2 before and after. Its Thai language check fails with the canned fake AI either way; that check needs a real model.
- **Query budgets** (`QUERY_BUDGETS` and `escalationQueryBudget` in `perf/scenarios.ts`): every scenario the benchmark measures carries one, at its count after this ticket (retrieval and the chat turn allow the keyword top-up a small Project needs). `perf/query-budgets.api.test.ts` seeds the small large-Organization, runs every scenario on the real app and fails when one sends more than its budget, or repeats a statement 10 times (an N+1); a second test shows one statement over the budget fails. The escalation job's budget is 3 + 14 per batch of 200, so it can never grow per request. The benchmark flags `over budget` too. `bun run bench --only <text>` measures some scenarios only.
- **Connection pool**: `createPrismaClient` takes `poolSize` (default `DEFAULT_POOL_SIZE` 10, pg's own default, now explicit) and the server reads `DATABASE_POOL_SIZE`. One server process has one pool, shared by requests and its background jobs. The widest request (the Inbox) runs 5 statements at once, the escalation job holds one connection per batch and runs batches one after another, and the chat card, indexing and Receipt work is short statements. 10 leaves room for two Inboxes and a job at once; raise it only when requests wait for a connection, and keep instances x pool size under Postgres' `max_connections` (100 by default) minus some for migrations and `psql`. See `docs/performance.md`.
- **Before and after**, large dataset (seed 73), 60 runs each (the escalation job 12), both on this session's machine back to back: Intel Xeon @ 2.80 GHz, 4 cores, 16 GB, Linux 6.18; PostgreSQL 16.13 with pgvector 0.6.0, default settings; Bun 1.4.2 (`BUN_OPTIONS=--smol` in this environment). This is not the 0073 machine (2.10 GHz): its numbers are in the last column for reference only. The after run is the new `docs/performance-baseline.json`.

  | Scenario | Before p50 | Before p95 | After p50 | After p95 | p95 change | Queries | Budget | 0073 p95 |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | GET /inbox | 80.8 | 109.9 | 40.7 | 63.1 | -43% | 22 → 15 | 15 | 84.5 |
  | Feature page (5 requests) | 21.4 | 31.3 | 19.3 | 29.1 | -7% | 31 | 31 | 32.8 |
  | GET /features/:id | 2.4 | 3.0 | 2.3 | 3.0 | 0% | 5 | 5 | 3.4 |
  | GET /features/:id/spec-versions | 2.7 | 3.8 | 2.0 | 2.5 | -34% | 6 | 6 | 4.4 |
  | GET /features/:id/decision-log | 4.0 | 6.2 | 4.0 | 5.0 | -19% | 9 | 9 | 4.8 |
  | GET /features/:id/role-owners | 1.8 | 2.1 | 1.9 | 2.7 | +29% (noise) | 4 | 4 | 3.4 |
  | GET /features/:id/attachments | 6.6 | 11.8 | 7.0 | 11.1 | -6% | 7 | 7 | 11.8 |
  | Retrieval (Feature, pgvector) | 14.7 | 19.7 | 14.4 | 21.5 | +9% (noise) | 29 → 25 | 27 | 17.3 |
  | GET /projects/:id/decision-stats | 72.5 | 102.3 | 38.9 | 54.1 | -47% | 17 → 12 | 12 | 83.8 |
  | Escalation job (every open request) | 10,432.9 | 12,691.7 | 282.2 | 403.8 | -97% | 22,595 → 72 | 87 | 12,461.5 |
  | Chat turn (fake AI) | 42.7 | 54.8 | 40.5 | 55.6 | +1.5% (noise) | 83 → 79 | 81 | 59.8 |

  The three rows that got slower at p95 are within run-to-run noise at 1-3 ms: role-owners and the chat turn don't run any changed code path on their own (the chat turn's retrieval is the one below), and retrieval measured over 200 runs each, back to back, is p50 13.9/12.7 ms and p95 18.7/17.0 ms after against p50 15.1/14.2 ms and p95 20.1/20.5 ms before. The escalation job does the same work (1,147 due requests checked, 1,392 steps taken) in 72 statements instead of 22,595; its N+1 flag is gone.
- **Left for later**: the Inbox is still unbounded (now about 2,650 items for Pim in 40 ms); paging it is a product decision for the web and CLI. A scope of more than 20,000 chunks that is a small share of a much larger Organization would still lose recall to HNSW post-filtering on pgvector 0.6; pgvector 0.8's iterative index scans (`hnsw.iterative_scan`, in the compose image) would fix that, but the measuring server has 0.6. Measuring with `pg_stat_statements` needs a server that loads it.
- **No new domain term.**

