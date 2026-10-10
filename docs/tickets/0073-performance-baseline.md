---
status: done
depends-on: []
slice: performance
---

# 0073: Performance baseline

## Goal
We know how fast the hot paths are on a large Organization, and where the time goes, before optimizing anything.

## Scope
- **A large seeded dataset:** a script seeds, for example, 50 Projects, 500 Features, 20,000 Decision Requests (in every state, with Redrafts, Delegations and escalations) and 200,000 content chunks with embeddings. It reuses the large-project fixture (`apps/server/src/retrieval/large-project.fixture.ts`) and is repeatable from a fixed seed.
- **A benchmark script** (`bun run bench`) measures p50 and p95 of the hot endpoints:
  - the Inbox (`GET /inbox`);
  - the Feature page (the Feature, its Spec, Decision Log and Attachments);
  - retrieval (pgvector) for a Feature-level task;
  - `GET /projects/:id/decision-stats`;
  - the escalation job over every open Decision Request;
  - a chat turn with the fake AI.
- **Query count per request:** the benchmark records how many queries each request runs, to catch N+1.
- **Guidance** in `docs/performance.md`: turning on `pg_stat_statements` and the slow query log in `docker compose`, and reading them.
- **Baseline:** the numbers are recorded in this ticket's Decisions, with the machine they ran on.
- **CI:** a non-blocking job runs the benchmark on a smaller dataset and keeps its results as an artifact, to watch trends. It never fails a PR.

## Acceptance criteria (test first where it applies)
- [x] The seed script builds the dataset from a fixed seed, and a test checks the counts on a small version of it.
- [x] The benchmark reports p50, p95 and query count per endpoint, as a table and as JSON.
- [x] A test catches an N+1: a scripted endpoint that queries per row exceeds its query count.
- [x] Baseline numbers are recorded in this ticket.
- [x] The CI job runs on PRs and is marked non-blocking.

## Decisions
- **The large Organization** (`apps/server/src/perf/large-organization.ts`, `seedLargeOrganization`): built from a fixed seed (`SeededRandom`, mulberry32, default 73) with seeded UUIDs and every timestamp placed relative to a fixed "now" (`LARGE_ORG_NOW`, 2026-06-01 10:00 UTC, inside the default working hours), so the same seed builds the same rows. Three scales: `large` (50 Projects, 500 Features, 20,000 Decision Requests, 200,000 chunks, 200 people), `medium` for CI (a tenth) and `small` for its test. It sits on `seed()` and `seedFullTeam()`: Pim is a PO in every Team and a Role Owner of every Feature (the heaviest Inbox), and "Async checkout" carries the large-project fixture's handbook, so the benchmark checks retrieval still finds the needle paragraph. Decision Requests are in every state (the first six of each Feature cycle through them), with Choices, Redrafts of them (one in ten), Claims (`DeciderChange`), NEEDS_INFO spells, Decisions with Spec Proposals (approved ones become Spec Versions in approval order; some DECIDED ones wait as Inbox Items), Delegations (a Tech Lead's second Tech Lead; some requests sent to the Delegate, some with the Delegate added at escalation step 2) and escalation steps with their history and Notifications, due dates computed with the real `addWorkingTime` and `escalationTimes`. Chunks are cut by the real `chunkMarkdown` (Decisions with `decisionText`, the latest Spec Version, the Brief, Project and Feature Attachments; generated documents use one chunk per section so the total is exact) and embedded with `fakeEmbedding` (256 dimensions, made-up vocabulary so vectors spread), bulk-inserted, then the HNSW index is built once with the repository's own statement (`hnswIndexSql`, now exported). The embeddings provider is configured, so retrieval ranks by vector.
- **Its own database**: `BENCH_DATABASE_URL`, default `vorasaan_bench`; `prepareDatabase` (test helpers) now also accepts names ending in `_bench`, and `createTestApp({ databaseUrl })` boots against it. The large seed takes about 3.5 minutes here (205 s) and is reused while it has the asked scale (`--reseed`). What the escalation job changes is snapshot in a `bench` schema right after seeding and restored before each run of it, so every run starts from the same state.
- **The benchmark** (`bun run bench`, `apps/server/scripts/bench.ts`, harness in `src/perf/bench.ts`, scenarios in `src/perf/scenarios.ts`): the server in-process (test app: `FakeAiPort`, `FakeEmbeddingPort`, the clock at "now"), requests through `app.inject` as Pim, so no network, TLS or web rendering is counted. p50/p95 (nearest rank) over 30 runs after a warm-up (the escalation job: 6 runs); queries per run from Prisma's query events (`createPrismaClient`'s `onQuery` now also gets each statement's duration; `recordQueries` returns them); database time is their summed duration (parallel statements overlap, so it can exceed wall time); statements are grouped by shape (parameters and `IN` lists collapsed) and the most repeated one is reported, flagged **N+1** at 10 or more (`N_PLUS_ONE_REPEATS`); a scenario may carry a `queryBudget` (left to 0074). Output: a Markdown table and JSON (machine, dataset counts, per-scenario numbers, top statements by database time, and `pg_stat_statements`' top 15 when loaded); `--compare` prints p95 and query count against an earlier JSON.
- **The N+1 test** (`perf/bench.api.test.ts`) boots a scripted Nest endpoint on the test database that loads 15 Features and then each one's latest Spec Version: the harness reports 16 queries, the Spec Version statement 15 times, N+1 and over its budget of 3; the same answer with a join stays within budget. `perf/large-organization.api.test.ts` seeds the small scale and checks its counts (every state on every Feature, exact chunk count, all embedded, the HNSW index), and that the same seed gives the same fingerprint and another seed another. Both run in `bun run test` (about 10 s together); the large seed and the benchmark don't.
- **Diagnostics**: `docker-compose.perf.yml` (an override on the `db` service) loads `pg_stat_statements` and logs statements over 100 ms and lock waits; `docs/performance.md` explains running the benchmark, its columns, and reading `pg_stat_statements`, the slow log and `EXPLAIN`.
- **CI**: `.github/workflows/bench.yml` runs `bun run bench --scale medium --iterations 20` on every PR, adds the table to the job summary and keeps the JSON and table as an artifact for 90 days. The job and its steps continue on error, so it never fails a PR. Runners vary: compare runs of that job with each other, not with this baseline.
- **Baseline** (`docs/performance-baseline.json`), on the session's machine: Intel Xeon @ 2.10 GHz, 4 cores, 16 GB, Linux 6.18; PostgreSQL 16.13 with pgvector 0.6.0 on the same machine with default settings (128 MB shared_buffers, not the compose file's pg17); Bun 1.4.2. `pg_stat_statements` could not be loaded on that server, so the "where the time goes" below comes from the benchmark's own per-statement timings. Large scale, seed 73, 30 runs each:

  | Scenario | p50 ms | p95 ms | Queries | DB ms p50 | Most repeated |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | GET /inbox | 67.5 | 84.5 | 22 | 116.6 | 2× |
  | Feature page (5 requests) | 23.2 | 32.8 | 31 | 18.2 | 5× |
  | GET /features/:id | 2.9 | 3.4 | 5 | 2.3 | 1× |
  | GET /features/:id/spec-versions | 3.6 | 4.4 | 6 | 3.1 | 1× |
  | GET /features/:id/decision-log | 4.2 | 4.8 | 9 | 5.4 | 2× |
  | GET /features/:id/role-owners | 2.6 | 3.4 | 4 | 1.6 | 1× |
  | GET /features/:id/attachments | 7.4 | 11.8 | 7 | 3.5 | 1× |
  | Retrieval (Feature, pgvector) | 12.0 | 17.3 | 29 | 30.6 | 2× |
  | GET /projects/:id/decision-stats | 60.9 | 83.8 | 17 | 32.8 | 3× |
  | Escalation job (every open request) | 11,687.5 | 12,461.5 | 22,595 | 11,066.4 | 1,454× (N+1) |
  | Chat turn (fake AI) | 47.8 | 59.8 | 83 | 65.4 | 5× |

  Retrieval found the needle paragraph. A medium run on the same machine for reference (5 runs): Inbox p95 24.8, decision-stats 75.2, retrieval 35.5, escalation 1,447 ms with 2,308 queries.
- **Where the time goes, for 0074 and 0076**:
  - **The escalation job is the outlier**: 551 due OPEN requests, one transaction each (`FOR UPDATE SKIP LOCKED`, by design for several instances), about 41 statements per request: per step a `RequestHistoryEntry` insert, Notifications, a `User` lookup for the history's names (1,454 times per run), the request's recipients, and the Notifications re-read by `publish`; `COMMIT` alone takes about half the database time (5.9 s over 6,882 commits per 6 runs). Batching the reads across due requests and the user lookups, while keeping a lock per request, is the first target.
  - **The Inbox is unbounded**: Pim's has about 1,630 Decision Requests to decide or Claim and 1,025 Spec Proposals to approve, all loaded and sorted in memory on every read. Its time is in the OPEN-requests query with its `recipients` filter and the follow-up `Feature`/`User` lookups by long `IN` lists. Candidates: pagination or a limit, an index for `RequestRecipient (userId)` with the request's status, and fewer separate relation loads.
  - **decision-stats** rebuilds every timeline of the Project in the app (17 queries; recipients, history, Decider changes and messages loaded by `IN` lists); it is 61 ms for one Project of 374 sent requests and grows with the range and the Project.
  - **Retrieval and the chat turn** are a fixed few queries: no N+1. The chat turn's 83 statements are mostly the Conversation's own writes and its context (Brief, Guidelines, retrieval); its vector search is the most expensive single statement. Retrieval was faster on the large dataset (p95 17 ms) than on the medium one (35 ms), which suggests the planner picks different plans by size: 0074's `ef_search` tuning should `EXPLAIN` both. 0076 can use the chat-turn and retrieval scenarios to check that trimming context doesn't add queries.
  - **The Feature page** reads are 2-8 ms each with a fixed query count; Attachments (p95 11.8 ms) is the slowest of them.
- **No new domain term** (the benchmark and its dataset are tooling, not product language); nothing was optimized here.
