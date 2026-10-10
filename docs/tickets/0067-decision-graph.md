---
status: done
depends-on: [0020, 0055, 0058, 0065]
slice: decision-graph
---

# 0067: Decision Graph of a Feature

## Goal
Anyone on a Feature's page sees at a glance how its Spec got where it is: which Decision Requests branched off, which are still open, and which Spec Version each one produced.

## Scope
- **The graph**, like a git network graph, on the Feature page:
  - The main lane is the Feature's Spec. Each node is a Spec Version, including manual edits and reverts (0020).
  - Each Decision Request branches off at the Spec Version that was current when it was raised, and merges back at the Spec Version its approved Spec Proposal produced.
  - A request decided without a Spec change is a closed branch without a merge.
  - Open branches (waiting for a Decider, NEEDS_INFO, a Spec Proposal awaiting approval) are dashed, with the 0055 labels (due, overdue, escalated).
  - Redrafts (0065) of the branch's proposals show as small marks on the branch.
- **Hover or focus** shows the question, the Raiser, the Decider, the chosen Choice (or the written answer), where it was decided (web, CLI, Slack, LINE or Teams, 0058), and the Spec Version it produced (vX → vY).
- **Click** opens the Decision Request, or the diff of a Spec Version.
- **Access:** keyboard navigable (arrow keys move along and between lanes, Enter opens), an `aria-label` on every node and branch, light and dark tokens (ADR 0008). At 375px it scrolls sideways inside the graph only; the page doesn't.
- **API:** `GET /features/:id/decision-graph` returns nodes and edges, with a Zod contract in `@vorasaan/shared`. It is built from existing data, with no new tables.

## Acceptance criteria (test first, real Postgres)
- [x] Branch and merge points are right for a Feature with several Decision Requests and a manual edit and a revert in between.
- [x] A request decided without a Spec change is a closed branch with no merge.
- [x] Open requests (waiting, NEEDS_INFO, Spec Proposal awaiting approval) are open branches with their state and Response Window label.
- [x] Someone who can't read the Feature gets a 404.
- [x] Browser-verified: hover shows the details, click opens the request and the diff, the keyboard moves between nodes, and it works at 375px.

## Decisions
- **API contract** (`@vorasaan/shared` `decision-graph.ts`): `GET /features/:id/decision-graph` returns `DecisionGraphView { featureId, nodes, branches }`.
  - `nodes` are the main lane, oldest first: every Spec Version (`version`, `source`, `summary`, `revertedFrom`, `approvedBy`, `createdAt`) and `requestId`, the Decision Request whose approved Spec Proposal produced it (a merge), or null for a manual edit, a revert or an AI draft from elsewhere.
  - `branches` are the edges: one per sent Decision Request (drafts are never shown), oldest sent first, with `fromVersion` (the Spec Version current when it was sent, by `submittedAt`; null when the Feature had no Spec yet) and `toVersion` (the version its approved Spec Proposal produced; null unless merged). Each carries the question, `kind`, `status`, a derived `state`, the Raiser, the Decider (null while unclaimed) and `deciderRole`, `sentAt`, `endedAt`, the Decision (`choice` or `customAnswer`, `decidedBy`, `onBehalfOf`, `source` from 0058, `createdAt`), `specProposalId`, `redrafts` (one per Redraft from 2 on, of its Choices or of its Spec Proposal, with `createdAt`), `responseWindow` (0055 state, only while waiting) and `labels`.
  - `state`: `WAITING` (OPEN), `NEEDS_INFO`, `AWAITING_APPROVAL` (DECIDED with its Spec Proposal PENDING), `MERGED` (SPEC_UPDATED), `CLOSED` (DECIDED without a Spec change: its Spec Proposal was rejected) and `WITHDRAWN`. `OPEN_BRANCH_STATES` lists the first three, drawn dashed. A withdrawn request is a closed branch too, in the same muted colour, since it was sent and someone may look for it.
  - `labels` are `responseWindowLabels` at the server's clock when the graph is read ("due in 2h", "overdue 1h", "escalated"); none while NEEDS_INFO, when the clock is paused.
- **The fork is when the request was sent, the merge is what its proposal produced.** A request decided after the Spec moved on (here, after a revert) still forks where it was sent, and merges where its proposal was approved. No new tables: the fork is found by time from `submittedAt` and the Spec Versions' `createdAt`; the merge from `Decision → SpecProposal → resultVersion`.
- **Access:** everyone in the Feature's Organization reads the graph; anyone else gets a 404, the same as for a Feature that doesn't exist, so the answer says nothing about whether it exists.
- **Queries:** the Feature (with the access check), then its Spec Versions, its sent requests (with their Decision, Choice, people and Spec Proposal) and the Redrafts, in parallel. Related rows are matched in memory rather than joined through nested selects, so the read is a fixed number of SQL statements (Prisma reads each relation level in one more statement) however many requests there are. To test that, `createPrismaClient` takes an optional `onQuery` hook, and the test app records the SQL its client sends (`recordQueries`).
- **Web** (`components/decision-graph.tsx`, `lib/decision-graph-layout.ts`): a "Decision Graph" tab on the Feature page, after the Decision Log, loaded only when open.
  - Layout like a git network graph: time runs left to right, one column per event (a Spec Version, a request sent, a request closed), with an extra "now" column when a branch is open. The main lane is at the top; each branch takes the first lane below that is free from the column it was sent in to the column it ends in, so lanes are reused. A branch drops from its fork with a rounded corner, runs along its lane, and either rises into its merge node, ends with a cap (closed or withdrawn), or runs dashed to "now" with its state and labels written at the end. Redrafts are short ticks on the lane, placed by time. The layout is a pure function with its own unit tests and no "now" of its own, so the server and the browser draw the same picture.
  - Colours (ADR 0008): jade for Spec Versions and merged branches (a revert is a hollow jade node), ink for a branch whose Spec Proposal awaits approval and for Redraft marks, saffron for a branch waiting on a person, lacquer for a Blocker's node, the faint line colour for closed branches. A legend under the graph says the same in words.
  - Every Spec Version and request node is a link with an `aria-label` ("Spec v4. Reverted to v1, approved by Pim." / "Blocker: Webhook or polling?. Decided and merged into the Spec. v1 → v2."). Hover or keyboard focus shows the kit `Tooltip` with the details. The branch lines are decoration (`aria-hidden`); the request node speaks for its branch.
  - Keyboard: one Tab stop (roving tabindex, starting at the latest Spec Version). Left and Right move along a lane, Up and Down to the nearest node on the next lane, Home and End to a lane's ends, Enter opens. A click or Enter on a request opens `/requests/:id`; on a Spec Version, the Version history with its diff (`?tab=history&diff=N`).
  - The graph sits in a `section` that scrolls sideways (`overflow-x-auto`), so at 375px only the graph scrolls. With no Decision Requests the tab shows the kit `EmptyState`, with "Raise a Decision Request" for a Role Owner.
- **Tests.**
  - `decision-graph.api.test.ts` (real Postgres): branch and merge points across a merged request, a manual edit, a revert and a request decided on the reverted version (fork v3, merge v5); a request decided with its Spec Proposal rejected is `CLOSED` with no merge; open requests (waiting with a due label, NEEDS_INFO paused with none, a Spec Proposal awaiting approval with a Redraft, overdue and escalated labels), a withdrawn request, and a draft that is no branch; Redrafts of a draft's Choices; a Feature with no requests; 404 for someone outside the Organization and for an unknown Feature; the same number of SQL statements for one request and for five.
  - `decision-graph-layout.test.ts`: columns, lane reuse, overlapping branches, open branches to "now", a request sent before v1, and the arrow-key moves.
  - e2e `decision-graph.e2e.ts` (seeded by `seed-decision-graph.ts`): node and branch counts and labels, dashed open branches, the Redraft mark, hover details (Raiser, Decider, Choice, Slack, v1 → v2, Redraft), axe clean in light and dark, keyboard moves along and between lanes with the tooltip following, Enter opening the request, a click opening the v2 diff; at 375px the graph scrolls and the page doesn't; the empty state is axe clean. All e2e specs pass.
- **Left open.** Long histories make a wide graph (one column per event); it scrolls, but there is no zoom or folding of old versions yet. Only the nodes are hover targets, not the branch lines.

