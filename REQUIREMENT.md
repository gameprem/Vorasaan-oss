# Vorasaan (วรสาร) - Product Requirements & Technical Design

**Positioning:** The Open-Source Agentic Alignment Engine for Software Teams.
**Core principle:** "AI Proposes, Human Approves" (Human-in-the-Loop).
**Goal:** Turn vague product ideas and mid-flight blockers into strict, versioned, execution-ready Specs before AI coding assistants (Claude Code, Aider, OpenCode) write code.
**License:** AGPL-3.0

> Capitalized domain terms (Feature, Spec, Decision Request, Decider...) are defined in [`CONTEXT.md`](./CONTEXT.md). Architectural decisions live in [`docs/adr/`](./docs/adr/).

---

## 1. Product Decisions

| Area | Decision |
| --- | --- |
| Deployment | Self-hosted, one instance per Organization (docker-compose). `Organization` stays in the schema for a future SaaS, but there is no tenant isolation yet. |
| Source of truth | **Vorasaan** ([ADR 0001](./docs/adr/0001-vorasaan-is-the-source-of-truth.md)). Confluence, Jira, Figma and Docs are Attachments aggregated on the Feature page to give a single overview. |
| Jira | Optional, read-only link from a Feature to a Jira **Epic** (`jiraIssueKey` is nullable). Features can start in the Web UI or from an existing Epic. There is no Epic/Task creation or Confluence write-back in the MVP. |
| Language | UI and prompt templates are in English. The agent replies in the user's language, and the Spec follows the conversation's language. |
| LLM | Defaults to Anthropic directly via `ANTHROPIC_API_KEY`, entered in `/setup`. 9Router (or any OpenAI-compatible endpoint) is optional. |
| Spec format | **Markdown is canonical** ([ADR 0002](./docs/adr/0002-markdown-is-the-canonical-spec-format.md)). BlockNote converts to and from Markdown when editing. |
| File storage | Attachment files go through a `FileStorage` interface. The default is local disk (a Docker volume); any S3-compatible bucket (S3, MinIO, R2) is enabled by setting `FILE_STORAGE_DRIVER=s3` and `S3_*` env vars. |
| Default model | `claude-opus-5-5` for every workflow. Each workflow can name its own model so they can be split later. Admins can change it. After the MVP, Admins connect several providers and approve a list of models; people pick one per Conversation ([ADR 0010](./docs/adr/0010-approved-models-and-the-chat-picker.md)). |
| AI context | **Retrieval, not everything** ([ADR 0007](./docs/adr/0007-retrieval-with-pgvector.md)). Content is chunked and embedded into Postgres with pgvector. A workflow gets its Feature's own context first, then the most relevant chunks from the Project, within a token budget. Embeddings go through an `EmbeddingPort`; the default is any OpenAI-compatible endpoint set by an Admin. |

---

## 2. Target Users

* **PO:** Owns the Spec. Decides business Decision Requests with one click on a Choice Widget instead of long Slack threads. Is notified of every new Spec Version.
* **Designer / Tech Lead:** Decide Decision Requests routed to their domain (UX / technical).
* **Developer:** Raises Decision Requests from the `vorasaan` TUI with local repo context attached. Can do everything on the Web UI as well.
* **QA:** Reads the versioned Spec and Decision Log. Can raise Decision Requests on unclear acceptance criteria.

---

## 3. MVP Scope - Decision Requests & Choice Engine

The MVP is built around the differentiating feature: **Decision Request → Choices → Decision → Spec Version**.

### 3.1. Onboarding
1. **First-boot `/setup`:** create the Organization. The first user becomes org `ADMIN` and enters the LLM API key. Setup needs the one-time Setup Token the server prints to its log, so whoever reaches a fresh install first can't claim it.
2. ADMIN creates **Project → Team → Feature** and invites members by email.
3. Members get Team Roles. Each Feature gets Role Owners; a Team Role can have several Role Owners on one Feature.

### 3.2. Feature Page (single overview)
* **Attachments:** file upload (md/pdf/images, stored via `FileStorage`), public URL, Confluence and Jira (via an org-level Atlassian API token). Content is captured as a **Snapshot** so the AI can use it as context. A **Refresh** button re-fetches.
* **Spec editor:** BlockNote, stored as Markdown.
* **Initial Spec:** the PO writes or pastes it, **or** the AI drafts one from Attachments as a Spec Proposal that the PO approves.
* **Version History:** like Confluence. Each Spec Version records who approved it, its source (manual / AI summary / decision / revert) and the linked Decision, and shows a diff against the previous version. The PO can revert.
* **Decision Log tab:** every Decision, linked to the Spec Version it produced.
* **Blocked badge:** shown while any **Blocker** is open. Open Questions don't mark a Feature as Blocked.

### 3.3. Decision Request Flow

A **Decision Request** is either a **Blocker** (the Raiser's work stops) or a **Question** (the Raiser keeps working). Both share one flow.

1. **Raise:** any Role Owner of the Feature can be the Raiser. They pick the Feature from a list (scoped to the bound Project if `vorasaan init` was run), choose Blocker or Question, describe it, and can attach local context (`--file`, `--diff`, text).
2. **Generate:** by default the AI produces **2–4 Choices**. Each has an impact on scope, time and risk. The AI also suggests the **decider role** (business → PO, technical → Tech Lead, UX → Designer). A Question may skip Choices and be asked as plain text.
3. **Review (`DRAFT`):** the Raiser reviews, edits, adds or removes Choices, and confirms or changes the decider role. A "send now" shortcut skips the edits.
4. **Choose recipients:** the Raiser sends the request to **one Role Owner** of that role, or to **all of them**.
   * If there is only one Role Owner for the role, they are selected automatically.
   * If the Feature has no Role Owner for the role, the request goes to all Team members with that Team Role.
   * Active **Delegations** are applied: a recipient on leave is replaced by their Delegate.
5. **Decider:** there is always at most one Decider, and the Decider is never the Raiser.
   * Sent to one person → that person is the Decider.
   * Sent to several → there is no Decider until one of them **Claims** it (or decides directly, which implies a Claim). The others are notified and it leaves their Inbox.
   * Anyone with the required Team Role in the Team can **Claim** a request routed to someone else.
6. **Decide:** the Decider can:
   * pick a Choice,
   * **answer in their own words** (free text),
   * **ask for more info** (→ `NEEDS_INFO`, a question goes back to the Raiser),
   * **reassign** to someone else.
7. **Spec update:** the AI drafts a Spec Proposal. The **Decider approves it**, a new Spec Version is created, and the Feature's **PO Role Owners are notified** and can revert. If the Decision needs no Spec change, the request ends at `DECIDED`.
8. The Raiser may **withdraw** at any time before the Decision. There is no automatic escalation in the MVP.

**States:** `DRAFT → OPEN ⇄ NEEDS_INFO → DECIDED → SPEC_UPDATED`, plus `WITHDRAWN`.
A Feature may have several open Decision Requests at once.

### 3.4. Delegation
* A person going on leave sets a **Delegate** for a Team and Team Role over a date range. An ADMIN can set it for them (e.g. sudden sick leave).
* The Delegate must hold the same Team Role in that Team.
* Decisions made as a Delegate record **"decided by C on behalf of A"**.

### 3.5. Inbox & Notifications
* **Inbox Items** need action and disappear when done. They are derived from state, not stored:
  * decide an `OPEN` request where I'm the Decider;
  * Claim or decide an `OPEN` request with no Decider where I'm a recipient;
  * answer a `NEEDS_INFO` request I raised;
  * approve a `PENDING` Spec Proposal where I'm the approver.
* **Notifications** are informational and have read state: request decided, claimed or withdrawn, new Spec Version, Delegation started.
* Web Inbox only (no email, no webhooks in the MVP). Both streams go to the CLI over SSE.

### 3.6. `vorasaan` CLI (persistent TUI)
* Running `vorasaan` opens a long-lived TUI (Ink) with three tabs:
  * **Inbox**: my Inbox Items, then Notifications.
  * **My Requests**: Decision Requests I raised and their status.
  * **Features**: Features where I'm a Role Owner. Features bound to the current repo are highlighted, and the latest Spec is readable in the tab.
* `r` raises a Decision Request from any tab, attaching context from the current repo.
* **OS desktop notifications** when new items arrive.
* Full parity with the Web UI: a Dev can act in either.
* `vorasaan init` (optional) binds the repo to a Project to shorten the Feature list. It writes `.vorasaan/config.json`.
* Scriptable subcommands remain available (e.g. `vorasaan raise`).

### 3.7. Auth & Permissions
* **Web:** email + password. Users join by admin invitation only.
* **CLI:** Personal Access Token generated in the Web UI.
* **Org Roles:** `ADMIN` (settings, integrations, create Project/Team, invite, set Delegations for others) and `MEMBER`.
* **Team Roles:** `PO`, `DESIGNER`, `TECH_LEAD`, `BACKEND`, `FRONTEND`, `MOBILE`, `QA`. They are held per Team membership: a person can hold several, and one Team Role can be held by many people.
* Everyone in the Organization can **read** every Feature. **Actions** (decide, Claim, approve Spec Proposals) require the matching Team Role. NestJS Guards enforce this.

### 3.8. Project Brief, Grilling & Feature Suggestions ([ADR 0006](./docs/adr/0006-project-brief-above-features.md))
Before and alongside Features, a Project has a shared foundation the AI and new Features build on. It works for a **new Project** (start from Grilling) and an **existing one** (start from what is already there).

* **Project Brief:** Markdown, versioned like the Spec (Brief Versions, diff, revert). Sections: business goals, target users, **current capabilities**, constraints, non-goals. Admins and the POs of the Project's Teams approve changes.
* **Grilling:** the AI asks rounds of questions (business → UX → technical) to the people with those Team Roles, then drafts a Brief proposal that a PO approves. It can be re-run later to update the Brief.
* **Existing Projects:** before asking, the AI reads what exists: Project-level Attachments (docs, Confluence, Jira project), the Features and Specs already in Vorasaan, and an optional **Repo Scan** from `vorasaan scan` (or `vorasaan init --scan`). It drafts "current capabilities" and asks only about the gaps.
  * The Repo Scan is opt-in every time, shown to the user before sending, and contains a summary only (README, dependency manifests, main modules and routes), never whole source files.
* **Feature Guidelines:** criteria a Feature must meet for the business (KPIs it serves, constraints, required sections). An Admin sets the Organization default; each Project can override or extend it. Shown as a checklist when someone proposes a Feature, and used by the AI to check a Feature idea's fit and ask about what is missing.
* **Feature Suggestions:** the AI proposes Features from the Brief, the Guidelines, capability gaps and the Decision Log, each with rationale, business value, effort and risk. A PO **accepts** (a Feature is created with an AI-drafted Spec Proposal) or **dismisses with a reason** (used as context next time).
* The Brief and the effective Guidelines are context for every AI workflow in the Project (Choices, Spec Proposals, Suggestions).

---

## 4. Domain Model

```
Organization ─┬─ OrgMembership (User, ADMIN|MEMBER)
              ├─ Invitation
              ├─ OrgIntegration (ANTHROPIC | OPENAI_COMPATIBLE | ATLASSIAN)
              └─ Project (jiraKey?)
                   └─ Team ─┬─ TeamMembership (User, TeamRole)       many per role
                            ├─ Delegation (delegator → delegate, role, period)
                            └─ Feature (jiraIssueKey? → Epic)
                                 ├─ RoleOwner (User, TeamRole)       many per role
                                 ├─ Attachment (snapshotText)
                                 ├─ SpecVersion (markdown, immutable, numbered)
                                 ├─ SpecProposal (AI draft, approver, PENDING → APPROVED/REJECTED)
                                 └─ DecisionRequest (BLOCKER|QUESTION, raiser, decider?)
                                      ├─ RequestRecipient (User)
                                      ├─ RequestContext (TEXT|FILE|DIFF)
                                      ├─ Choice (2–4, optional for Questions)
                                      ├─ RequestMessage (NEEDS_INFO thread)
                                      └─ Decision (decidedBy, onBehalfOf?) ── SpecProposal ── SpecVersion
User ── Session, PersonalAccessToken, Notification
```

The source of truth is `packages/db/prisma/schema.prisma`.

---

## 5. Technical Architecture

**Bun + Turborepo monorepo, ESM everywhere** ([ADR 0005](./docs/adr/0005-bun-as-runtime-and-package-manager.md)). Bun is the runtime, package manager and test runner. Workspace packages export `.ts` source directly. Lint/format: Biome.

### `apps/web`
Next.js 16 (App Router), TailwindCSS, Shadcn UI, BlockNote (Markdown in and out).

### `apps/server`
* NestJS 12 + Fastify adapter. Strict Module / Controller / Service. Request/response validation uses the Zod schemas from `packages/shared` via Standard Schema; there are no class-validator DTOs ([ADR 0004](./docs/adr/0004-zod-is-the-only-api-contract.md)).
* `MastraModule`: Mastra used as a **library** (singleton provider). Workflow snapshots (`suspend`/`resume`) live in the same Postgres but a **separate schema** from Prisma ([ADR 0003](./docs/adr/0003-mastra-as-a-library-inside-nestjs.md)).
* `FeatureModule`, `DecisionRequestModule`, `DelegationModule`, `SpecModule`, `AttachmentModule`, `AuthModule`, `InboxModule` (Inbox Items + Notifications over SSE).
* Atlassian connector: read-only fetch in the MVP.

### `apps/cli`
Bun, Commander.js (subcommands), **Ink** (persistent TUI), SSE client, OS notifications. Shipped as a single binary via `bun build --compile`.

### `packages/`
* `db`: Prisma 7 schema (`prisma-client` generator, `@prisma/adapter-pg`, URL in `prisma.config.ts`) and `createPrismaClient()`.
* `shared`: Zod 4 schemas and inferred types, the single API contract for server, web and CLI.
* `skills`: Markdown prompt templates per team/role (Choice generation, decider-role suggestion, Spec Proposal drafting, Attachment summary).

### Infrastructure
`docker-compose.yml`: PostgreSQL with pgvector by default. `--profile router` adds 9Router (`decolua/9router`, port 20128). `--profile app` adds server and web.

---

## 6. Roadmap

### Phase 1: Foundation
- [x] Root `package.json` (Bun workspaces), `turbo.json` (`tasks`), Biome, base tsconfig.
- [x] CI (GitHub Actions: lint, typecheck, test with Postgres), added once the tracer bullet has tests.
- [x] `schema.prisma` for the MVP domain model (Prisma 7) + initial migration.
- [x] `CONTEXT.md` glossary, ADRs 0001–0005, `CLAUDE.md`, `README.md`.
- [x] Scaffold `apps/web`, `apps/server`, `apps/cli` and `packages/skills` as workspace packages.
- [x] Zod schemas in `packages/shared` (align with Prisma enums: add `TECH_LEAD`, `DecisionRequest` replaces `BlockerPayload`).
- [x] `docker/Dockerfile.server` and `docker/Dockerfile.web`; `docker compose up` runs the whole product.

### Tracer bullet (first)
Seed data → `vorasaan raise` (plain prompt) → Mastra generates Choices → web page to decide → Spec Proposal approved → Spec v2 in the Decision Log. No auth, onboarding, TUI, recipients/Claim/Delegation, NEEDS_INFO, Attachments or SSE yet. Broken into tickets in `docs/tickets/`.

### Phase 2: MVP Backend
- [x] Auth (email/password, invitations, PAT) and Org/Team Role Guards.
- [x] `/setup` API, Project/Team/Feature CRUD, Role Owners.
- [x] Attachments with Snapshot + refresh (file, URL, Confluence, Jira).
- [x] Spec Versions, Spec Proposals, diff, revert.
- [x] Mastra workflows: Choice generation, decider-role suggestion, Spec Proposal drafting, Attachment summary.
- [x] Decision Request state machine, recipients, Claim, reassign, NEEDS_INFO thread.
- [x] Delegations.
- [x] Inbox Items (derived) + Notifications + SSE stream.

### Retrieval (after the MVP backend, before the Project foundation)
- [x] pgvector, content chunks, `EmbeddingPort` and indexing.
- [x] A context retriever used by every AI workflow.

### Project foundation (after the MVP backend, before the MVP Web UI)
- [x] Project Brief with Brief Versions and Project-level Attachments.
- [x] Feature Guidelines (Organization default + Project override).
- [x] Grilling workflow, including existing Projects and the opt-in Repo Scan.
- [x] Feature Suggestions and the Guidelines fit check.
- [x] Web and CLI for all of the above.

### Phase 3: MVP Web UI
- [x] Setup wizard, onboarding, members & invitations.
- [x] Feature page: Attachments, BlockNote Spec editor, Version History with diff, Decision Log.
- [x] Choice Widget, Claim, and Spec Proposal approval.
- [x] Inbox, Delegation settings.

### Phase 4: MVP CLI
- [x] PAT login, optional `vorasaan init`.
- [x] Ink TUI: Inbox / My Requests / Features tabs, raise a Decision Request with repo context.
- [x] OS notifications.

### MVP polish (follow-ups from the MVP reviews)
- [x] Any Organization member reads the Feature Guidelines (0038).
- [x] End-to-end browser tests in CI (0039).
- [x] `GET /me/teams` for the Delegation and CLI pickers (0040).
- [x] Hardening: SSE ends on a revoked token, Attachment file cleanup and the orphan sweep, TUI polish (0041).

### Post-MVP (in order)
1. **Chat-first Web UI** ([ADR 0008](./docs/adr/0008-chat-first-web-ui.md)): a Sidebar (Inbox, Projects → Features, recent Conversations, and Settings, which opens as a full-screen modal with Back) and a Conversation with the AI per Project or Feature. The AI proposes through Action Cards that a person approves, and Grilling runs as per-person Conversations with follow-ups. It looks like Gemini, with the palette from ADR 0008 (mockup: `docs/design/chat-web-ui-mockup.html`).
   - [x] Conversations and streamed AI replies (0042).
   - [x] Action Cards (0043).
   - [x] Grilling as per-person Conversations (0044).
   - [x] App shell with the Sidebar and the Settings modal (0045).
   - [x] Chat view, Action Cards and the document panel (0046).
   - [x] Grilling in the chat view (0047).
   - [x] End-to-end tests for the chat UI (0048).
   - [x] Several AI providers and Approved Models chosen by an Admin, with a model per AI task (0053, [ADR 0010](./docs/adr/0010-approved-models-and-the-chat-picker.md)).
   - [x] A model picker in the chat: each Conversation remembers its model, and every reply records the model that wrote it (0054).
2. **Context management** ([ADR 0012](./docs/adr/0012-context-budgets-and-auto-compaction.md)): token counts that are right for Thai, context budgets as shares of each model's window, and Conversations that auto-compact into a structured summary (goal, agreed points, open questions, pending Action Cards, preferences) instead of forgetting. Compact and retry once when a provider says the prompt is too long. Prompt caching for the stable prefix.
   - [x] Count tokens correctly for Thai (0059).
   - [x] Context budgets from the model, and auto-compaction (0060).
   - [x] Prompt caching (0061).
3. **Decision speed** ([ADR 0011](./docs/adr/0011-response-windows-and-deciding-from-chat-apps.md)): every Decision Request has a Response Window (Blocker 4 working hours, Question 2 working days by default). Past it, it escalates: reminders, then the Delegate, then the Raiser and Tech Leads. Escalation never decides or reassigns by itself. Decision Lead Time is measured per Project. Recipients can link LINE, Slack or Teams and decide from a card there.
   - [x] Response Windows and escalation (0055).
   - [x] Decision Lead Time (0056).
   - [x] Link a LINE, Slack or Teams account (0057).
   - [x] Decide from LINE, Slack and Teams (0058).
4. **OpenRouter** as an AI Provider: the Admin enters only the key, picks Approved Models from OpenRouter's model list with their Context Window prefilled, and Anthropic models routed through it get prompt caching.
   - [x] OpenRouter provider (0064).
5. **Request changes** ([ADR 0013](./docs/adr/0013-request-changes-redrafts-proposals.md)): every AI proposal (Choices, Spec Proposals, Brief Proposals, Feature Suggestions, later Design Docs) gets Request changes next to Approve and Decline. The person explains what to change, and the AI writes a Redraft of the same proposal. Earlier Redrafts stay, with their feedback and a diff. Nothing changes until Approve. It works from Chat Cards too.
   - [x] Request changes and Redrafts (0065).
6. **UI kit** ([ADR 0016](./docs/adr/0016-ui-kit-on-react-aria-components.md)): our own accessible components on React Aria, styled with the ADR 0008 tokens in light and dark, in `apps/web/components/ui/`. Searchable pickers for models, Team Roles, people, Features and time zones (in English and Thai), and date and time pickers with an optional Buddhist-era year. They replace every browser-native select, checkbox, radio, date and time input.
   - [x] UI kit, and replace browser-native controls (0077).
7. **Context meter, `/compact` and chat history:** a meter under the composer shows how full the Conversation is for its model's Context Window, and a person can compact it themselves, with a focus that steers the Conversation Summary. Older messages stay readable, with a thin divider where the AI switched to the summary. Long Conversations open at the latest messages and load older ones as you scroll up.
   - [x] Context meter, /compact, chat history and cursor pagination (0066).
8. **Decision Graph:** a graph like a git network graph on the Feature page. The Spec's versions are the main lane; each Decision Request branches off where it was raised and merges back at the Spec Version it produced, and open ones show their Response Window state.
   - [x] Decision Graph of a Feature (0067).
9. **Language:** prompts keep domain terms, ids, numbers, names and quoted words as written, and reply in the person's language, else the Organization's. Every eval set gets Thai and mixed Thai-English cases, and answering directly is measured against reasoning in English first.
   - [x] Language rules and Thai eval cases (0068).
10. **Learning Loop** ([ADR 0015](./docs/adr/0015-learning-loop-humans-change-the-ai.md), inspired by [Reef](https://github.com/Human-Agent-Society/reef)): every AI call leaves a Receipt, and what people did with its proposal is linked to it. An Organization can hold its own Prompt Versions and evaluate them in the app. The AI proposes better Prompt Versions from the feedback, with eval scores; only an Admin's approval makes one active. No automatic publishing, no training in the product, and a JSONL export for other tools.
    - [x] Receipts and feedback (0070).
    - [x] Prompt Versions and in-app evals (0071).
    - [x] The AI proposes better prompts (0072).
11. **Optimization:** measure first on a large seeded Organization, then make the database faster and the AI cheaper without answering worse.
    - [x] Performance baseline (0073).
    - [x] Database optimization (0074).
    - [ ] AI usage dashboard (0075).
    - [ ] Token optimization with an eval guard (0076).
12. **Platforms and Coverage** ([ADR 0009](./docs/adr/0009-platforms-and-coverage.md)): each Project lists its Platforms (Back-End, Front-End, Mobile, and later Flutter or others), started from a template. Features target them, and each target Platform gets a Spec section. Coverage shows which Platforms are covered or missing and why (Spec section, someone to ask, open Blockers, QA ready), using the checks each Platform switches on. The AI fills or asks about the gaps. Design Docs wait for a Platform's Coverage.
    - [ ] Platforms per Project, targeted by Features (0050).
    - [ ] Coverage per Platform, used by the AI (0051).
    - [ ] Web and CLI: Platform chips and the Coverage matrix (0052).
13. **Agent Skills** ([ADR 0017](./docs/adr/0017-agent-skills-installable-skill-md-packages.md)): the AI can use Agent Skills in the open SKILL.md format (the same folders coding assistants use, such as [diagram-design](https://github.com/cathrynlavery/diagram-design)). An Admin installs one from a GitHub URL or a zip, pinned to the version installed, approves it and enables it per Project; an update shows a diff first. Skills are text and templates only: no script in them ever runs. The AI sees only their names and descriptions and loads a Skill or one of its files when it needs it. What it makes with a Skill (a diagram, say) is shown sandboxed and reaches a Spec or Design Doc only as a proposal a person approves. Receipts record which Skills a call used.
    - [ ] Agent Skills (0078).
14. **Design Docs per Platform** ([ADR 0014](./docs/adr/0014-design-docs-derived-from-the-spec-per-platform.md)): once a Feature's Spec is approved and a Platform's Coverage is complete, the AI drafts that Platform's Design Doc (Back-End, Front-End, Mobile, QA) from a template the Project can edit. The Platform's Tech Lead or Role Owners approve it. When the Spec changes, the Design Docs it affects go stale and the AI proposes an update.
    - [ ] Design Docs per Platform (0069).
15. `vorasaan run --ai claude`: write the Feature's distilled context to `.vorasaan/specs/<feature>.md` (latest Spec, relevant Decisions, retrieved chunks and project rules, plus the Jira Epic key if linked) and hand it to the coding assistant, so it reads one Feature's context instead of everything. It also hands over the Feature's approved Design Doc for the developer's Platform.
16. **Grilling Workflow:** PO → Designer → Dev question rounds that produce the Spec, as per-person Conversations (ADR 0008).
17. **Design Flow Revision:** cascade impact analysis (minor → auto Spec Proposal; major → `REVISION_PENDING` with PO + Dev sign-off).
18. Jira/Confluence write-back (Epic/Task creation) and Figma / Google Docs connectors.
19. Browser-based `vorasaan login`.
20. Open-source release: README, CONTRIBUTING, architecture diagrams, publish `@vorasaan/cli`.
    - [x] First-run setup requires a Setup Token from the server log (0062). Required before the first public release.
    - [x] Setup asks for the time zone, working days and hours, and language; a Getting started checklist follows (0063).

### Later (recorded, not scheduled)
- **Drift check:** a GitHub App reads a PR, compares it with the Feature's Spec and Decisions, and comments or opens a Question when they disagree. It builds on `vorasaan run`.
- **Decisions from meeting notes:** paste a transcript or notes, and the AI proposes the decisions it finds as Action Cards for people to confirm.
- **SSO and audit export:** Google, Microsoft or OIDC sign-in, and an exportable audit log of approvals and decisions.
