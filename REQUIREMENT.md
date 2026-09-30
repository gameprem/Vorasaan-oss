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
| Default model | `claude-opus-5-5` for every workflow. Each workflow can name its own model so they can be split later. Admins can change it. |

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
1. **First-boot `/setup`:** create the Organization. The first user becomes org `ADMIN` and enters the LLM API key.
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
`docker-compose.yml`: PostgreSQL by default. `--profile router` adds 9Router (`decolua/9router`, port 20128). `--profile app` adds server and web.

---

## 6. Roadmap

### Phase 1: Foundation
- [x] Root `package.json` (Bun workspaces), `turbo.json` (`tasks`), Biome, base tsconfig.
- [ ] CI (GitHub Actions: lint, typecheck, test with Postgres), added once the tracer bullet has tests.
- [x] `schema.prisma` for the MVP domain model (Prisma 7) + initial migration.
- [x] `CONTEXT.md` glossary, ADRs 0001–0005, `CLAUDE.md`, `README.md`.
- [ ] Scaffold `apps/web`, `apps/server`, `apps/cli` and `packages/skills` as workspace packages.
- [ ] Zod schemas in `packages/shared` (align with Prisma enums: add `TECH_LEAD`, `DecisionRequest` replaces `BlockerPayload`).
- [x] `docker/Dockerfile.server` and `docker/Dockerfile.web`; `docker compose up` runs the whole product.

### Tracer bullet (first)
Seed data → `vorasaan raise` (plain prompt) → Mastra generates Choices → web page to decide → Spec Proposal approved → Spec v2 in the Decision Log. No auth, onboarding, TUI, recipients/Claim/Delegation, NEEDS_INFO, Attachments or SSE yet. Broken into tickets in `docs/tickets/`.

### Phase 2: MVP Backend
- [ ] Auth (email/password, invitations, PAT) and Org/Team Role Guards.
- [ ] `/setup` API, Project/Team/Feature CRUD, Role Owners.
- [ ] Attachments with Snapshot + refresh (file, URL, Confluence, Jira).
- [ ] Spec Versions, Spec Proposals, diff, revert.
- [ ] Mastra workflows: Choice generation, decider-role suggestion, Spec Proposal drafting, Attachment summary.
- [ ] Decision Request state machine, recipients, Claim, reassign, NEEDS_INFO thread.
- [ ] Delegations.
- [ ] Inbox Items (derived) + Notifications + SSE stream.

### Phase 3: MVP Web UI
- [ ] Setup wizard, onboarding, members & invitations.
- [ ] Feature page: Attachments, BlockNote Spec editor, Version History with diff, Decision Log.
- [ ] Choice Widget, Claim, and Spec Proposal approval.
- [ ] Inbox, Delegation settings.

### Phase 4: MVP CLI
- [ ] PAT login, optional `vorasaan init`.
- [ ] Ink TUI: Inbox / My Requests / Features tabs, raise a Decision Request with repo context.
- [ ] OS notifications.

### Post-MVP (in order)
1. `vorasaan run --ai claude`: inject the latest Spec Markdown as context.
2. **Grilling Workflow:** PO → Designer → Dev question rounds that produce the Spec.
3. **Design Flow Revision:** cascade impact analysis (minor → auto Spec Proposal; major → `REVISION_PENDING` with PO + Dev sign-off).
4. Jira/Confluence write-back (Epic/Task creation) and Figma / Google Docs connectors.
5. Browser-based `vorasaan login`.
6. Open-source release: README, CONTRIBUTING, architecture diagrams, publish `@vorasaan/cli`.
