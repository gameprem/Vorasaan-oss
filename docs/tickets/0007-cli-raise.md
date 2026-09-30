---
status: todo
depends-on: [0005]
slice: tracer-bullet
---

# 0007: `vorasaan raise` CLI command

## Goal
A developer raises a Decision Request from the terminal and reviews the AI's Choices before sending.

## Scope
- Turn `apps/cli` into the workspace package `@vorasaan/cli`, TypeScript on Bun, with Commander (replace `bin/vorasaan.js`).
- Config from env for now: `VORASAAN_API_URL` (default `http://localhost:4000`) and `VORASAAN_USER` (the dev user id sent as `x-vorasaan-user`). PAT login comes in the MVP.
- `vorasaan raise`, an interactive flow using plain prompts (e.g. `@clack/prompts`). The Ink TUI comes in the MVP.
  1. Pick a Feature from `GET /features`.
  2. Choose Blocker or Question, then enter a title and description.
  3. Show a spinner while the AI drafts, then display the Choices (label, title, impact on scope/time/risk) and the suggested decider role.
  4. Let the user send as-is, change the decider role, edit a Choice's text, or withdraw.
  5. Submit, then print who the Decider is.
- Non-interactive flags for scripting: `--feature`, `--kind`, `--title`, `--description`, `--yes` (send without review).
- `bun run --filter @vorasaan/cli build` produces a single binary via `bun build --compile` (ADR 0005).

## Acceptance criteria
- [ ] Against the seeded server, Beam can raise and submit a Blocker, and it shows up as `OPEN` for Pim.
- [ ] API errors (e.g. 422 for an ambiguous Decider) are shown as readable messages, not stack traces.
- [ ] The compiled binary runs without Bun or Node installed.
- [ ] Tests cover argument parsing and the API client, using a stub HTTP server.
