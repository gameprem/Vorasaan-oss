---
status: done
depends-on: []
slice: mvp-polish
---

# 0039: End-to-end browser tests in CI

## Goal
The main web flows are checked automatically on every PR, instead of by hand in each ticket.

## Scope
- The seed adds a second PO (and a Designer and a Tech Lead) so multi-recipient, Claim and Grilling flows can run.
- Playwright tests in `apps/web/e2e/`, run against a real server with `VORASAAN_AI=fake`, `VORASAAN_DEV_AUTH=true` and fake embeddings:
  1. raise → send to all POs → Claim → ask for info → answer → decide → approve Spec Proposal;
  2. Inbox updates live without a reload;
  3. Spec edit → diff → revert;
  4. Grilling → approve Brief → accept a Feature Suggestion → approve its Spec.
- A CI job that starts Postgres (pgvector), the server and the web app, runs the tests, and uploads the Playwright report on failure. Uses the Playwright browsers the job installs; no secrets.

## Acceptance criteria
- [ ] The four flows pass in CI on a PR.
- [x] Breaking one of them (e.g. hiding the Claim button) turns the job red. (Checked locally: with the Claim form hidden, the flow fails at "Claim it".)
