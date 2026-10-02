# Vorasaan

Open-source "AI proposes, human approves" alignment engine. Product scope: `REQUIREMENT.md`.

## Before you write code

- Read `CONTEXT.md`. Use its terms exactly (Feature, Spec, Decision Request, Decider, Role Owner...) in code, UI copy, commits and tickets. Never use a word from an _Avoid_ list: no `Blocker` model (it's a `DecisionRequest` with `kind = BLOCKER`), no `assignee`, no `ticket` for product concepts.
- Check `docs/adr/` before revisiting a settled decision. If you make a decision that is hard to reverse, surprising, and a real trade-off, propose a new ADR.
- If a new domain term appears, add it to `CONTEXT.md` (glossary only, no implementation details).

## Workflow

- Work one ticket at a time from `docs/tickets/`: one ticket = one branch = one PR.
- Branch from and open PRs against **`development`** (the default branch). Branch names: `feat/NNNN-slug`, `fix/...`, `chore/...`.
- `main` only moves on an explicit release (merge `development` → `main`). Never commit to either directly.
- This repo stays **private**. The public open-source repo will be a separate repository that receives only `main` on release, so unreleased work never leaks.
- Keep the ticket's `status` frontmatter up to date.

## Stack & conventions

- **Bun** (version in `package.json` `packageManager`) as runtime, package manager and test runner, plus Turborepo (ADR 0005). **ESM everywhere.** Workspace packages export `.ts` source; there is no build step for `packages/*`.
- `apps/server`: NestJS 12 + Fastify. Mastra is a library inside `MastraModule` (ADR 0003).
- `apps/web`: Next.js 16. `apps/cli`: Commander + Ink.
- `packages/db`: Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`). Use `createPrismaClient()`; never `new PrismaClient()` elsewhere.
- `packages/shared`: **Zod schemas are the only API contract** (ADR 0004). NestJS validates them via Standard Schema. Don't write class-validator DTOs.
- Specs are Markdown (ADR 0002).
- Store Attachment files through the `FileStorage` interface, never `fs` directly.
- Secrets in `OrgIntegration` are encrypted with `VORASAAN_SECRET_KEY`.

## Testing

- `bun test`. Service-layer tests run against a real Postgres (`docker compose up db`), never a mocked Prisma.
- Test-drive the Decision Request state machine (states, Claim, Delegation, NEEDS_INFO) before implementing it.
- LLM calls go through an interface. Tests use a deterministic fake. Prompt quality is measured by the eval set, run manually, not in automated tests.

## Commands

```bash
docker compose up -d db     # Postgres for dev/tests (docker compose up -d = full stack)
bun install
bun run db:generate         # Prisma client
bun run db:migrate          # create/apply migrations (dev)
bun run lint                # Biome (bun run format to fix)
bun run typecheck
bun run test
bun run check               # all three; run before committing
```

CI (`.github/workflows/ci.yml`) runs the same `bun run check` on every PR, but still run it (lint → typecheck → test, stops at the first failure) before every commit. `bun test` alone does **not** type-check.
