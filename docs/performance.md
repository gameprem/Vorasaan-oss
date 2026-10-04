# Performance: the benchmark and query diagnostics

How fast the hot paths are on a large Organization, and where the time goes (ticket 0073).
Measure here first; optimize after (0074 for the database, 0076 for tokens).

## The benchmark

```bash
docker compose up -d db          # or any Postgres with pgvector
bun run bench                    # the baseline: the large Organization
bun run bench --scale medium     # a tenth of it (what CI runs)
bun run bench --compare docs/performance-baseline.json
```

It runs against its own database, `BENCH_DATABASE_URL` (default
`postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_bench`; the name must end in `_bench`,
because the benchmark empties it). It never touches the dev or test databases.

1. **Seeds the large Organization** (`apps/server/src/perf/large-organization.ts`) from a fixed
   seed (`--seed`, default 73), so every run measures the same rows, ids included:

   | Scale | Projects | Features | Decision Requests | Content chunks | People |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | `large` (default) | 50 | 500 | 20,000 | 200,000 | 200 |
   | `medium` (CI) | 5 | 50 | 2,000 | 20,000 | 40 |
   | `small` (its test) | 2 | 6 | 72 | 600 | 16 |

   Decision Requests are in every state (DRAFT, OPEN, NEEDS_INFO, DECIDED, SPEC_UPDATED,
   WITHDRAWN), with Choices, Redrafts of them, Claims, NEEDS_INFO spells, Decisions with Spec
   Proposals and Spec Versions, Delegations (some sent to a Delegate, some with a Delegate added
   by escalation) and escalation steps with their history and Notifications. Chunks have
   256-dimension vectors from `FakeEmbeddingPort` and the HNSW index the app uses. It sits on
   top of `bun run db:seed`'s people: **Pim** (Admin) is a PO in every Team and a Role Owner of
   every Feature, so hers is the heaviest Inbox, and **Async checkout** carries the large-project
   fixture's handbook (`retrieval/large-project.fixture.ts`), so the benchmark checks retrieval
   still finds its needle paragraph. Time is fixed: the data's "now" is 2026-06-01 10:00 UTC,
   and the app's clock is set to it. The large seed takes a few minutes and is kept: the next
   run reuses it while it still has that scale (`--reseed` rebuilds it; `--seed-only` stops
   after seeding).
2. **Boots the server in-process** (the test app: `FakeAiPort`, `FakeEmbeddingPort`, requests
   through `app.inject`, so no network, TLS or web rendering is counted) and runs each hot path
   `--iterations` times (default 30) after a short warm-up:

   | Scenario | What runs |
   | --- | --- |
   | `GET /inbox` | Pim's Inbox |
   | Feature page (5 requests) | the five reads of the Feature page, one after another; each also on its own |
   | Retrieval (Feature, pgvector) | `ContextRetriever.forFeature` with the fixture question and the Decision Request budget |
   | `GET /projects/:id/decision-stats` | Decision Lead Time, default range |
   | Escalation job | `EscalationJob.run()` over every OPEN request due, from the same seeded state each run (a fifth as many runs) |
   | Chat turn (fake AI) | `POST /conversations/:id/messages` in a Feature Conversation |

3. **Reports**, as a Markdown table and as JSON (`bench-results/<scale>-<time>.json`, and `.md`
   next to it; `--out` to choose), per scenario:
   - **p50, p95** (and mean, min, max in the JSON), in ms, of the whole run;
   - **Queries**: SQL statements per run, from Prisma's query events (a range when runs differ);
   - **DB ms p50**: the sum of those statements' durations. Statements run in parallel
     (`Promise.all`) overlap, so it can exceed the wall time; compare it with p50 to see whether
     the time is in the database or in the app;
   - **Most repeated**: the statement shape (parameters and `IN` lists collapsed) sent most
     often within one run. **N+1** is flagged at 10 or more: something runs a query per row;
   - the five statements with the most database time over all runs (`topStatements`), and
     `pg_stat_statements`' top 15 when the server loads it (below);
   - **over budget** when a scenario has a `queryBudget` and sends more (0074 sets them).

`--compare <previous.json>` adds each scenario's p95 and query count against that file. The
baseline of ticket 0073 is `docs/performance-baseline.json` (with its machine in it): compare
only with runs on similar hardware.

### In CI

`.github/workflows/bench.yml` runs `bun run bench --scale medium` on every PR, writes the table
to the job summary and keeps the JSON as an artifact for 90 days. It never fails a PR (the job
and its steps continue on error). GitHub runners vary: watch the trend across runs of that job,
not single numbers, and never compare them with the baseline from a developer machine.

## pg_stat_statements and the slow query log

Start the dev database with the diagnostics override:

```bash
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d db
```

It loads `pg_stat_statements` (every statement's calls and time), logs every statement slower
than 100 ms with its parameters, and logs lock waits. Start without the override to turn it off
again. The extension must also be created once in each database you look at (the benchmark
does it in its own):

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT pg_stat_statements_reset();   -- start counting from now
```

Then use the app (or run `bun run bench`) and read them.

**Where the database time goes** (the most total time first):

```sql
SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query,
       calls, round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       rows, shared_blks_read
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 20;
```

- High `total_ms` with high `calls` and a small `mean_ms`: a query run per row (an N+1), fixed by
  batching it, not by an index.
- High `mean_ms`: one slow statement. Run it with `EXPLAIN (ANALYZE, BUFFERS)` and look for a
  `Seq Scan` on a large table under a `WHERE` (a missing index), a sort spilling to disk
  (`Sort Method: external merge`), or many `shared_blks_read` (not in memory).
- `ORDER BY mean_exec_time DESC` finds the slowest single statements; `ORDER BY calls DESC` the
  chattiest.

**The slow query log** has each slow statement with its duration and parameters:

```bash
docker compose -f docker-compose.yml -f docker-compose.perf.yml logs db | grep duration:
```

Copy one into `psql` (`docker compose exec db psql -U vorasaan vorasaan_bench`), put its
parameters in, and `EXPLAIN (ANALYZE, BUFFERS)` it. For vector search, the plan should show
`Index Scan using "ContentChunk_embedding_hnsw_<dims>"`; the app sets `hnsw.ef_search` per query
(`ContentChunkRepository.search`), so set it the same way (`SET hnsw.ef_search = 300`) before
explaining.

Unused or missing indexes:

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 20;
```

A large table with a high `seq_tup_read` and few `idx_scan` is read whole by some query.
