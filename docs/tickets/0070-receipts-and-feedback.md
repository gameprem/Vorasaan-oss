---
status: todo
depends-on: [0061, 0065]
slice: learning-loop
---

# 0070: Receipts and feedback

## Goal
Every AI call leaves a Receipt, and what people did with its proposal is linked to it, so the Learning Loop has something to learn from (ADR 0015).

## Scope
- **A Receipt per AI call**, written by the server for every task (Choices, Spec Proposals, Redrafts, summaries, Grilling, Feature Suggestions, the fit check, chat turns):
  - the task, the prompt's name and its Prompt Version (the `packages/skills` default until 0071);
  - the Approved Model and its provider;
  - tokens in and out, cache reads and writes (0061, 0064), and latency;
  - a reference to the output (the proposal, Redraft or message it produced), not a copy of it;
  - the proposal it belongs to, when there is one.
  A failed call leaves a Receipt too, with its error.
- **Human outcomes**, linked to the Receipt that produced the proposal:
  - Approve, or Decline with its reason;
  - Request changes with its feedback (0065), and the number of Redrafts before approval;
  - a manual edit after approval (for example a Spec edited by hand within a Spec Version of the approved proposal), with its size.
- **Settings → AI (Admin):** turn collection on or off (on by default) and set retention (90 days by default). A daily job deletes Receipts past it. Turning collection off stops new Receipts; existing ones follow retention.
- **Export:** `GET /settings/ai/receipts/export` streams JSONL, one Receipt per line with its outcomes. People's names, emails and Attachment contents are left out; people appear as stable per-export ids. The format is documented in `docs/receipts-export.md` with a sample, and notes that it can feed Reef or other tools. The existing Redraft eval-case export (0065) stays.
- **Contracts:** Receipt and export line schemas in `@vorasaan/shared`.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] Raising a Decision Request writes a Receipt for its Choices with the task, prompt, Prompt Version, model, tokens, cache reads and writes and latency from the fake's usage.
- [ ] Request changes twice, then Approve: the Receipt's outcome shows Approve after 2 Redrafts, with both feedback texts.
- [ ] Decline with a reason, and a manual Spec edit after approval, are linked to their Receipts.
- [ ] With collection off, no Receipt is written; past retention, the job deletes Receipts and their outcomes.
- [ ] The export holds no person's name or email and no Attachment content, and each line parses with the shared schema.
- [ ] Only an Admin can change the settings or export (403 otherwise).
