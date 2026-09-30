---
status: todo
depends-on: [0021]
slice: mvp-backend
---

# 0023: AI: Attachment summary and an initial Spec from Attachments

## Goal
Instead of writing Spec v1 by hand, a PO asks the AI to draft it from the Feature's Attachments, then approves it (REQUIREMENT §3.2 Initial Spec).

## Scope
- New `AiPort` methods with prompt templates in `packages/skills`:
  - `summarizeAttachment`, stored alongside the Snapshot;
  - `draftSpecFromAttachments`.
- `POST /features/:id/spec-proposals/from-attachments`: PO Role Owners only. Creates a `PENDING` `SpecProposal` with `source: AI_SUMMARY` and `approverId` = the requester. Approving creates the next Spec Version via the existing approve path.
- Attachment and Decision Request context passed to Choice generation and Spec Proposal drafting includes Snapshots, truncated to a budget.
- `FakeAiPort` covers the new methods; add eval cases for the new prompts.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] With two Attachments, the PO gets a proposal, approves it, and the Feature has a Spec Version with `source: AI_SUMMARY`.
- [ ] A non-PO gets 403; a failed AI call writes nothing.
