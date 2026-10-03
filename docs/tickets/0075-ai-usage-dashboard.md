---
status: todo
depends-on: [0070, 0077]
slice: performance
---

# 0075: AI usage dashboard

## Goal
An Admin sees what the AI costs, where, and what it buys, from the Receipts (0070).

## Scope
- **Settings → AI usage (Admin):** for a date range, by task, Project and Approved Model:
  - tokens in and out;
  - estimated cost, from a price per million tokens the Admin sets on each Approved Model (none set means no cost shown, only tokens);
  - cache hit ratio (cache reads over input tokens);
  - latency, p50 and p95.
- **Headlines:** "cost per decision" (AI cost of a Decision Request from raise to Decision, including its Spec Proposal) and "Redrafts before approval" per task.
- **Budget (optional):** a monthly budget per Organization. At 80% and 100% the Admins get a Notification. Nothing is blocked.
- **UI:** built with the 0077 kit. Charts are accessible: each has a text summary and a table view, keyboard-focusable points, and colours from the ADR 0008 tokens in light and dark.
- **API:** `GET /settings/ai/usage` with a Zod contract in `@vorasaan/shared`, aggregated in the database.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] Usage totals by task, Project and model match the Receipts written in the test.
- [ ] Cost per decision includes the Choices, Redrafts and Spec Proposal of one Decision Request.
- [ ] The cache hit ratio and Redrafts before approval match scripted Receipts.
- [ ] Crossing 80% and 100% of the budget sends one Notification each to the Admins.
- [ ] Only an Admin can read usage (403 otherwise).
- [ ] Browser-verified: charts have a table view, work with the keyboard, and pass axe in light and dark.
