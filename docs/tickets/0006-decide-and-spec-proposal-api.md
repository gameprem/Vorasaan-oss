---
status: todo
depends-on: [0005]
slice: tracer-bullet
---

# 0006: Decide, draft a Spec Proposal, approve a Spec Version

## Goal
The Decider decides, the AI drafts the Spec change, and the Decider's approval creates a new Spec Version that is linked in the Decision Log.

## Scope
- `POST /decision-requests/:id/decision` (`DecideInput`):
  - Only the Decider, and only from `OPEN`. `choiceId` must belong to this request.
  - Creates the Decision and moves the request to `DECIDED`.
  - Calls `AiPort.draftSpecProposal` and stores a `SpecProposal` (`PENDING`, `source: DECISION`, `approverId` = Decider, `baseVersionId` = the current Spec Version).
  - Returns the request and the proposal.
- `GET /spec-proposals/:id`: returns a `SpecProposalView` with base and proposed Markdown, so the client can render a diff.
- `POST /spec-proposals/:id/approve`: approver only, from `PENDING`.
  - **In one transaction:** create Spec Version n+1 (`source: DECISION`, `approvedById`, `proposalId`), mark the proposal `APPROVED`, and move the request to `SPEC_UPDATED`.
  - If the Spec has moved on since `baseVersionId`, reject with 409 so nobody silently overwrites a newer version.
- `POST /spec-proposals/:id/reject`: approver only. The proposal becomes `REJECTED`, and the request stays `DECIDED`.
- `GET /features/:id/spec-versions` and `GET /features/:id/decision-log` (entries link each Decision to the Spec Version it produced, if any).

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] Full path: raise → submit → decide (Choice B) → approve → the Feature has Spec v2, and the Decision Log shows B linked to v2.
- [ ] A custom-answer Decision works the same way.
- [ ] Only the Decider can decide, and only the approver can approve or reject.
- [ ] Approving a stale proposal returns 409, and nothing is written.
- [ ] Approve is atomic: a forced failure mid-way leaves no partial Spec Version.
