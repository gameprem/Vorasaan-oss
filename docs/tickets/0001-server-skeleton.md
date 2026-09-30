---
status: todo
depends-on: []
slice: tracer-bullet
---

# 0001: Server skeleton and test harness

## Goal
A NestJS 12 app on Bun, wired to Postgres, with a test harness that later tickets use to test against a real database.

## Scope
- Turn `apps/server` into a workspace package `@vorasaan/server` (replace the placeholder `app.module.ts`).
- NestJS 12 with the Fastify adapter, running on Bun (`bun --watch src/main.ts` for `dev`). Enable decorator metadata in the package tsconfig.
- `PrismaModule` providing a single client from `createPrismaClient(process.env.DATABASE_URL)`.
- `GET /health` returns `{ ok: true }` after a `SELECT 1`.
- **Dev identity:** a guard that reads the `x-vorasaan-user` header (a User id), loads the User and attaches it to the request. It rejects with 401 if the header is missing or unknown. Name it clearly as dev-only; real auth replaces it in the MVP.
- **Test harness:** a helper that points at `DATABASE_URL` (a `vorasaan_test` database), applies migrations once, and truncates all tables between tests. Add a `test` script (`bun test`) to the package.

## Acceptance criteria
- [ ] `bun run dev` in `apps/server` starts the server on port 4000; `GET /health` returns 200.
- [ ] A test proves the dev guard: 401 without the header, 401 for an unknown id, 200 for a seeded user.
- [ ] `bun run test` at the repo root runs the server tests against real Postgres.
- [ ] `bun run lint` and `bun run typecheck` pass.

## Notes
- If NestJS decorators or DI misbehave on Bun, record the workaround and consider an ADR amendment (ADR 0005).
- Validation via Zod/Standard Schema is wired in 0005, not here.
