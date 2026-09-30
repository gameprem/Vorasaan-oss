# Tickets

One ticket = one branch (`feat/NNNN-slug`) = one PR. Update `status` in the frontmatter as you go (`todo` → `in-progress` → `done`). Don't start a ticket until everything in `depends-on` is `done`.

## Tracer bullet

Goal: prove the core loop end to end, as thinly as possible.

> A seeded Backend dev runs `vorasaan raise` → AI drafts Choices → the PO picks one on a web page → AI drafts a Spec Proposal → the PO approves → Spec v2 appears in the Decision Log.

Deliberately out of scope: auth (a dev header stands in for the user), onboarding UI, the Ink TUI, recipient selection, Claim, Delegation, NEEDS_INFO, Attachments, SSE and Notifications.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0001 | [Server skeleton and test harness](./0001-server-skeleton.md) | none |
| 0002 | [Seed data for the tracer bullet](./0002-seed-data.md) | 0001 |
| 0003 | [Shared contracts for Decision Requests and Specs](./0003-shared-contracts.md) | none |
| 0004 | [LLM port and the Choice generation workflow](./0004-choice-generation-workflow.md) | 0001, 0003 |
| 0005 | [Raise and submit a Decision Request](./0005-raise-decision-request-api.md) | 0002, 0003, 0004 |
| 0006 | [Decide, draft a Spec Proposal, approve a Spec Version](./0006-decide-and-spec-proposal-api.md) | 0005 |
| 0007 | [`vorasaan raise` CLI command](./0007-cli-raise.md) | 0005 |
| 0008 | [Web: decide and approve](./0008-web-decide-and-approve.md) | 0006 |

```
0001 ─┬─ 0002 ─┐
      └─ 0004 ─┼─ 0005 ─┬─ 0006 ── 0008
0003 ──────────┘        └─ 0007
```

0003 can run in parallel with 0001, and 0007 in parallel with 0006.
