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

## MVP

Goal: everything in REQUIREMENT §3 (Phases 2–4). The schema already covers the MVP domain, so most tickets need no migration.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0016 | [Recipients, Claim and reassign](./0016-recipients-and-claim.md) | none |
| 0017 | [Ask for more info (NEEDS_INFO thread)](./0017-needs-info-thread.md) | 0016 |
| 0018 | [Delegations](./0018-delegations.md) | 0016 |
| 0019 | [Inbox Items, Notifications and the event stream](./0019-inbox-notifications-sse.md) | 0017, 0018 |
| 0020 | [Spec editing, diff and revert](./0020-spec-edit-diff-revert.md) | none |
| 0021 | [Attachments: files and URLs, with Snapshots](./0021-attachments-file-and-url.md) | none |
| 0022 | [Attachments from Confluence and Jira](./0022-attachments-atlassian.md) | 0021 |
| 0023 | [AI: Attachment summary and an initial Spec from Attachments](./0023-ai-spec-from-attachments.md) | 0021 |
| 0024 | [Web: review, send, Claim, reassign, ask for info, withdraw](./0024-web-request-actions.md) | 0016, 0017, 0018 |
| 0025 | [Web: Inbox, Notifications and live updates](./0025-web-inbox-notifications.md) | 0019 |
| 0026 | [Web: Feature page with editor, history, diff, Attachments](./0026-web-feature-page.md) | 0020, 0021, 0023 |
| 0027 | [Web: Delegation settings](./0027-web-delegation-settings.md) | 0018 |
| 0028 | [CLI: `vorasaan` TUI and `vorasaan init`](./0028-cli-tui.md) | 0019 |
| 0029 | [CLI: live updates, OS notifications and acting from the TUI](./0029-cli-live-and-actions.md) | 0028, 0024 |

```
Decision Requests   0016 ─┬─ 0017 ─┬─ 0019 ─┬─ 0025
                          └─ 0018 ─┘        └─ 0028 ── 0029
                                  0016+0017+0018 ─ 0024 ─┘
                                  0018 ─ 0027
Spec                0020 ──────────────┐
Attachments         0021 ─┬─ 0022      ├─ 0026
                          └─ 0023 ─────┘
```

The three lanes (Decision Requests, Spec, Attachments) run in parallel. Inside the Decision Requests lane, 0017 and 0018 both change `decision-requests.service.ts`, so run them one after the other.

## Retrieval

Goal: AI workflows retrieve only the relevant context instead of reading everything (ADR 0007). Scheduled right after 0023.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0036 | [Vector foundation: pgvector, chunks, EmbeddingPort, indexing](./0036-vector-foundation.md) | 0023 |
| 0037 | [Context retriever for every AI workflow](./0037-context-retriever.md) | 0036 |

## Project foundation

Goal: a Project has a shared, human-approved foundation before and alongside its Features (REQUIREMENT §3.8, ADR 0006). Scheduled after the MVP backend (0019, 0022, 0023) and Retrieval (0036, 0037), and before the MVP Web UI (0024+).

| # | Ticket | Depends on |
| --- | --- | --- |
| 0030 | [Project Brief and Project-level Attachments](./0030-project-brief.md) | none |
| 0031 | [Feature Guidelines](./0031-feature-guidelines.md) | 0030 |
| 0032 | [Grilling a Project into a Brief](./0032-grilling.md) | 0030, 0031 |
| 0033 | [Repo Scan from the CLI (opt-in)](./0033-repo-scan.md) | 0030 |
| 0034 | [Feature Suggestions and the Guidelines fit check](./0034-feature-suggestions.md) | 0032 |
| 0035 | [Web: Project Brief, Grilling, Guidelines and Suggestions](./0035-web-project-foundation.md) | 0034 |

```
0030 ─┬─ 0031 ─┬─ 0032 ── 0034 ── 0035
      │        │
      └─ 0033 ─┘ (Grilling and Suggestions use the latest Repo Scan if there is one)
```

## MVP polish

Follow-ups recorded during the MVP reviews.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0038 | [POs can read the Organization's default Feature Guidelines](./0038-po-reads-org-guidelines.md) | none |
| 0039 | [End-to-end browser tests in CI](./0039-e2e-in-ci.md) | none |
| 0040 | [`GET /me/teams`](./0040-me-teams.md) | none |
| 0041 | [Hardening follow-ups from the MVP reviews](./0041-hardening.md) | none |

## Backlog

Recorded follow-ups that are not scheduled yet.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0049 | [Delete a Feature or a Project](./0049-delete-feature-project.md) | none |

## Chat-first Web UI (Post-MVP 1)

After the MVP release, the web app becomes a chat app (ADR 0008):
- A Sidebar holds the Inbox, Projects → Features, recent Conversations, and Settings, which opens as a full-screen modal with Back.
- In a Conversation, the AI proposes through Action Cards that a person approves.
- It looks like Gemini, with the palette from ADR 0008. The reference is [`docs/design/chat-web-ui-mockup.html`](../design/chat-web-ui-mockup.html).
- Grilling runs as per-person Conversations with follow-ups.

| # | Ticket | Depends on |
| --- | --- | --- |
| 0042 | [Conversations and streamed AI replies](./0042-conversations.md) | none |
| 0043 | [Action Cards: the AI proposes from a Conversation](./0043-action-cards.md) | 0042 |
| 0044 | [Grilling as per-person Conversations with follow-ups](./0044-grilling-in-conversations.md) | 0042 |
| 0045 | [Web: app shell with the Sidebar](./0045-web-shell-sidebar.md) | 0042 |
| 0046 | [Web: the chat view with Action Cards and a document panel](./0046-web-chat-view.md) | 0043, 0045 |
| 0047 | [Web: Grilling in the chat view](./0047-web-grilling-chat.md) | 0044, 0046 |
| 0048 | [End-to-end tests for the chat-first UI](./0048-chat-e2e.md) | 0039, 0046, 0047 |
| 0053 | [Several providers and Approved Models](./0053-providers-and-approved-models.md) | none |
| 0054 | [The model picker in chat](./0054-model-picker-in-chat.md) | 0042, 0053, 0046 |

```
0042 ─┬─ 0043 ─┐
      ├─ 0045 ─┴─ 0046 ─┬─ 0047 ── 0048
      └─ 0044 ──────────┘
```

## Decision speed (Post-MVP 2)

No Decision Request waits silently: Response Windows with escalation, Decision Lead Time, and deciding straight from LINE, Slack or Teams (ADR 0011).

| # | Ticket | Depends on |
| --- | --- | --- |
| 0055 | [Response Windows and escalation](./0055-response-windows.md) | none |
| 0056 | [Decision Lead Time](./0056-decision-lead-time.md) | 0055 |
| 0057 | [Link a LINE, Slack or Teams account](./0057-chat-app-accounts.md) | none |
| 0058 | [Decide from LINE, Slack and Teams](./0058-decide-from-chat-apps.md) | 0057 |

## Platforms and Coverage (Post-MVP 3)

Platforms per Project (Back-End, Front-End, Mobile, and later Flutter or anything a team adds). Features target them, and Coverage shows which are covered or missing and why (ADR 0009).

| # | Ticket | Depends on |
| --- | --- | --- |
| 0050 | [Platforms per Project, targeted by Features](./0050-platforms.md) | none |
| 0051 | [Coverage per Platform, and the AI uses it](./0051-coverage.md) | 0050 |
| 0052 | [Web and CLI: Platforms and Coverage](./0052-web-cli-platforms.md) | 0051, 0045 |
