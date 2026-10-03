---
status: todo
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
- [ ] Branch and merge points are right for a Feature with several Decision Requests and a manual edit and a revert in between.
- [ ] A request decided without a Spec change is a closed branch with no merge.
- [ ] Open requests (waiting, NEEDS_INFO, Spec Proposal awaiting approval) are open branches with their state and Response Window label.
- [ ] Someone who can't read the Feature gets a 404.
- [ ] Browser-verified: hover shows the details, click opens the request and the diff, the keyboard moves between nodes, and it works at 375px.
