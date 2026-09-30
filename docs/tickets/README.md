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

## Install & onboarding

Goal: install from scratch, choose an AI provider, sign in, and set up your own Organization without the seed script.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0009 | [AI providers from the database](./0009-ai-providers.md) | none |
| 0010 | [Email + password sign-in and access tokens](./0010-auth.md) | none |
| 0011 | [First-boot setup wizard](./0011-setup-wizard.md) | 0009, 0010 |
| 0012 | [Projects, Teams, members and Features in the web app](./0012-onboarding.md) | 0011 |
| 0013 | [One-command install with Docker](./0013-docker-install.md) | 0011 |
| 0014 | [CLI sign-in with a Personal Access Token](./0014-cli-login.md) | 0010 |

## Foundation

| # | Ticket | Depends on |
| --- | --- | --- |
| 0015 | [CI on GitHub Actions](./0015-ci.md) | none |
