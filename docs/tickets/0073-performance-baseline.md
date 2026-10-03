---
status: todo
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
- [ ] The seed script builds the dataset from a fixed seed, and a test checks the counts on a small version of it.
- [ ] The benchmark reports p50, p95 and query count per endpoint, as a table and as JSON.
- [ ] A test catches an N+1: a scripted endpoint that queries per row exceeds its query count.
- [ ] Baseline numbers are recorded in this ticket.
- [ ] The CI job runs on PRs and is marked non-blocking.
