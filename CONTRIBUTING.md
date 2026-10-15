# Contributing to Vorasaan

Thanks for helping. Bug reports, design feedback and code are all welcome. This guide covers how to get the code running, the checks a pull request must pass, and the conventions the codebase follows.

- [Prerequisites](#prerequisites)
- [Set up](#set-up)
- [Run the apps](#run-the-apps)
- [Checks](#checks)
- [End-to-end tests](#end-to-end-tests)
- [Tests and the AI](#tests-and-the-ai)
- [Conventions](#conventions)
- [Pull requests](#pull-requests)

New to the codebase? Read [`CONTEXT.md`](./CONTEXT.md) (the domain language) and [`docs/architecture.md`](./docs/architecture.md) (how the pieces fit) first.

## Prerequisites

| You need | Why |
| --- | --- |
| [Bun](https://bun.sh) **1.4.2** (the `packageManager` in [`package.json`](./package.json)) | Runtime, package manager and test runner ([ADR 0005](./docs/adr/0005-bun-as-runtime-and-package-manager.md)). There is no Node or pnpm step. |
| [Docker](https://www.docker.com/) | PostgreSQL 17 with the **pgvector** extension (`pgvector/pgvector:pg17`), for development and tests. |
| A Chromium for Playwright | Only for the end-to-end tests. |

You do **not** need an LLM key: `VORASAAN_AI=fake` runs everything with canned AI output.

## Set up

```bash
cp .env.example .env              # then set VORASAAN_SECRET_KEY (openssl rand -base64 32)
docker compose up -d db           # PostgreSQL + pgvector on :5432, and nothing else
bun install
bun run db:generate               # the Prisma client
bun --env-file=.env run db:migrate
bun --env-file=.env run db:seed   # demo Organization: pim@acme.test (PO, Admin), beam@acme.test (Backend)...
```

The seeded people all sign in with the password `vorasaan-demo`.

> [!NOTE]
> Bun reads a `.env` only from the directory a command runs in, and the `db:*` and `dev` scripts run inside their own package. Pass the root file with `bun --env-file=.env run …`, or export `DATABASE_URL` and `VORASAAN_SECRET_KEY` in your shell. Without it, Prisma fails with "Connection url is empty".

## Run the apps

```bash
VORASAAN_AI=fake bun --env-file=.env run --filter @vorasaan/server dev   # API on :4000
bun run --filter @vorasaan/web dev                                       # web on :3000
bun apps/cli/src/index.ts --help                                         # the CLI, from source
```

- **`VORASAAN_AI=fake`** swaps the LLM and the embeddings for deterministic fakes (canned Choices, Spec Proposals and so on). Drop it to use a real provider: set one up in the web app's setup wizard, or set `ANTHROPIC_API_KEY` (and optionally `VORASAAN_MODEL`) in `.env` for development.
- **`VORASAAN_DEV_AUTH=true`** (server and web) adds a user switcher to the web app, so you can act as any seeded person without signing out.
- **The CLI** talks to the API with an access token: in the web app open **Settings → Access tokens**, then `bun apps/cli/src/index.ts login --url http://localhost:4000`. `bun apps/cli/src/index.ts` with no command opens the TUI. `bun run --filter @vorasaan/cli build` writes the single binary to `apps/cli/dist/vorasaan`.

Everything at once in containers: `docker compose up -d` (see the [README](./README.md#-getting-started)).

## Checks

```bash
bun run check    # lint → typecheck → test; stops at the first failure
```

This is exactly what CI runs on every pull request (`.github/workflows/ci.yml`), plus a production `next build` of the web app and the end-to-end tests below. Run it before every commit. The pieces:

| Command | What it does |
| --- | --- |
| `bun run lint` | Biome lint and format check. `bun run format` fixes what it can. |
| `bun run typecheck` | `tsc` in every package. `bun test` alone does **not** type-check. |
| `bun run test` | `bun test` in every package. Server tests need the database running. |

Run one file while you work: `bun test src/spec/spec-history.api.test.ts` from `apps/server`.

> [!TIP]
> `next dev` and `next build` rewrite `apps/web/next-env.d.ts` with double quotes, which fails `bun run lint`. Run `git checkout apps/web/next-env.d.ts` before you commit.

### Tests use a real Postgres

Service and API tests (`*.api.test.ts`) boot the real NestJS app against a real database, never a mocked Prisma. The database is `TEST_DATABASE_URL` (default `vorasaan_test`). It is created and migrated on the first run, and its name must end in `_test` so a wrong URL can never empty your development data.

- On a slow disk, the first run can time out while it applies the migrations. Apply them once by hand: `DATABASE_URL=<your TEST_DATABASE_URL> bun run --filter @vorasaan/db db:deploy`.
- **Collation.** The Docker image sorts text with glibc's `en_US.utf8`, like CI. If you use a Postgres of your own whose default is `C`, create the test database with an en-US ICU collation so text sorts as it does in CI: `CREATE DATABASE vorasaan_test TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8';`. Tests must not depend on the collation either way: sort with an explicit tie-break, or `COLLATE "C"` in raw SQL.

## End-to-end tests

The main web flows run in a real browser with Playwright (`apps/web/e2e/*.e2e.ts`), against the real server with `VORASAAN_AI=fake` and the production web build.

```bash
# once: an e2e database, migrated (its name must end in _e2e)
DATABASE_URL=postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_e2e bun run --filter @vorasaan/db db:deploy
cd apps/web
bunx playwright install chromium   # or set E2E_CHROMIUM_PATH to a Chromium you have
bun --bun next build
bun run e2e                        # or: bun run e2e shell.e2e.ts
```

- Playwright starts the server on :4010 and `next start` on :3010, so your dev stack on :4000 and :3000 can keep running.
- Before every run, `e2e/global-setup.ts` empties `E2E_DATABASE_URL` (default `vorasaan_e2e`) and seeds it again. The setup wizard spec uses a second database next to it (`vorasaan_setup_e2e`), which it creates and migrates itself.
- Rebuild the web app (`bun --bun next build`) after changing it: the tests run the build, not your source.
- Failures leave traces and screenshots in `apps/web/test-results/`; `bunx playwright show-report` opens the HTML report.

### Accessibility

Every page must pass [axe](https://github.com/dequelabs/axe-core) (WCAG 2.1 A and AA) in **light and dark**: `e2e/a11y-pages.e2e.ts` visits each page in both colour schemes. A new page or tab goes into its list. Use the UI kit in `apps/web/components/ui/` (React Aria Components, [ADR 0016](./docs/adr/0016-ui-kit-on-react-aria-components.md)), not browser-native selects, checkboxes or date inputs, and the colour tokens from [ADR 0008](./docs/adr/0008-chat-first-web-ui.md), so contrast holds in both themes. `expectNoViolations(page)` from `e2e/fixtures.ts` checks a page in your own specs.

## Tests and the AI

- **Every LLM call goes through `AiPort`** (`apps/server/src/ai/ai.port.ts`); embeddings go through `EmbeddingPort`. No service imports a provider SDK or Mastra directly. See the [AI call path](./docs/architecture.md#ai-call-path).
- **Tests use the deterministic `FakeAiPort`.** `createTestApp()` (`apps/server/src/test/app.ts`) puts it under the real model routing and Receipts, and records each call so a test can assert on it. No automated test calls a real model.
- **Prompts** live as Markdown in [`packages/skills/prompts/`](./packages/skills/prompts/), one per AI task, with shared blocks in `partials/`. Placeholders are `{{name}}`, and `{{cacheBreak}}` marks the end of the cacheable prefix.
- **Prompt quality is measured by evals, run by hand.** They call a real model, cost money and are never part of `bun run check`. From the repository root:

  ```bash
  bun --env-file=.env run --cwd apps/server eval:choices   # also eval:grilling, eval:conversation, eval:design-docs...
  ```

  Each needs the key of the model it uses (`ANTHROPIC_API_KEY` for the default `anthropic/…` model; `VORASAAN_MODEL_<TASK>` picks another) and stops before any call when it is missing. The cases are in `apps/server/src/evals/cases/`. Admins can also run Eval Runs in the app, under **Settings → AI prompts**.
- **Token guards.** `src/evals/token-guard.test.ts` and `src/evals/token-scenarios.api.test.ts` run in `bun run test` and fail when an AI task's prompt grows in tokens, or its score on the fake drops. If you change a prompt on purpose, measure it with `bun run --cwd apps/server tokens:tasks` (`--cases-only` needs no database; `--out` and `--compare` show before and after) and update the recorded numbers in `src/evals/token-guard.ts`.

## Conventions

### Domain language

[`CONTEXT.md`](./CONTEXT.md) is the glossary. Use its terms exactly (Feature, Spec, Spec Proposal, Decision Request, Decider, Role Owner, Claim…) in code, UI copy, commit messages and pull requests, and never a word from an _Avoid_ list. For example, a Blocker is a `DecisionRequest` with `kind = BLOCKER`, not a model of its own; there is no "assignee" (it's the Decider, a Recipient or a Role Owner); a Feature is never a "ticket". A new domain term goes into `CONTEXT.md` in the same pull request, as a definition only.

### Code

- **Bun and ESM everywhere.** Packages in `packages/*` export their `.ts` source; there is no build step for them.
- **Zod is the only API contract** ([ADR 0004](./docs/adr/0004-zod-is-the-only-api-contract.md)). Define each request and response once as a Zod schema in `packages/shared`; the server validates it with `@Body({ schema })` through Standard Schema, and the web app and CLI import the same schema and type. No class-validator DTOs.
- **Database access** goes through `createPrismaClient()` from `@vorasaan/db`, never `new PrismaClient()`. Schema changes are Prisma migrations: edit `packages/db/prisma/schema.prisma`, then `bun --env-file=.env run db:migrate` to create one.
- **Files** (Attachments, Agent Skill files) are stored through the `FileStorage` interface (`apps/server/src/storage/file-storage.ts`, local disk or S3), never with `fs` directly.
- **Secrets** (provider keys, Atlassian and chat app tokens in `OrgIntegration`) are encrypted at rest with `SecretBox`, keyed by `VORASAAN_SECRET_KEY`. Never store or log them in plain text.
- **AI proposes, a person approves.** Nothing the AI writes changes a Spec, a Project Brief, a Design Doc or a Prompt Version until someone with the right role approves it ([ADR 0001](./docs/adr/0001-vorasaan-is-the-source-of-truth.md), [ADR 0008](./docs/adr/0008-chat-first-web-ui.md)).
- **The Decision Request state machine** is `apps/server/src/decision-requests/decision-request.state.ts`. Change it test-first, in `decision-request.state.test.ts`.

### Tickets and ADRs

- **Tickets** are in [`docs/tickets/`](./docs/tickets/README.md): one Markdown file each, with a `status` in its frontmatter (`todo`, `in-progress`, `done`) and its `depends-on`. One ticket is one pull request. Update the `status` as you go, and record what you decided in its Decisions section.
- **ADRs** are in [`docs/adr/`](./docs/adr/): short, numbered records of decisions already made. Read them before revisiting a settled choice. Propose a new ADR (the next number, a title that states the decision, a few paragraphs on context, decision and what was rejected) when a decision is **all three** of: hard to reverse, surprising to someone without the context, and a real trade-off.

### Commit messages

```
type(scope): summary (#NNNN)
```

- `type`: `feat`, `fix`, `docs`, `test`, `perf`, `chore`.
- `scope`: the part you changed, such as `server`, `web`, `cli`, `db`, `shared`, `skills` or `tickets`.
- `summary`: what changes for the person using it, in the present tense, using CONTEXT.md terms.
- `(#NNNN)`: the ticket number from `docs/tickets/`. Leave it off for a change that has no ticket.

For example: `feat(server): map one Reasoning Level to every provider, per task and per message (#0081)`.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep one change per pull request: one ticket, or one fix.
3. Run `bun run check`, and the end-to-end tests when you changed the web app.
4. Open the pull request against **`main`**. Say what changed and how you tested it, and link the ticket or issue.

For anything bigger than a small fix that has no ticket yet, open an issue first, so we can agree on the approach before you write the code.

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](./LICENSE), like the rest of Vorasaan.
