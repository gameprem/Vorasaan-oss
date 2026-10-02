---
status: done
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
- [x] With two Attachments, the PO gets a proposal, approves it, and the Feature has a Spec Version with `source: AI_SUMMARY`.
- [x] A non-PO gets 403; a failed AI call writes nothing.

## Notes
- The summary is stored in a new nullable `Attachment.summary` column (additive migration). It is written on add and refresh; a failed AI call logs a warning and leaves it null, and the Attachment is still saved. A refresh replaces (or clears) it, so it never describes an old Snapshot.
- As for editing the Spec by hand (0020), an Admin may also ask for the draft, and then approves it.
- 422 when no Attachment has Snapshot text; 502 when the AI output is invalid (nothing is written).
- One helper (`attachmentsForAi`) builds Attachment context: most recent Snapshot first, cut to a fixed character budget. Choices and Spec Proposals use summaries where present; the Spec draft uses full Snapshots. Prompts fence each Attachment in an `<attachment>` block marked as untrusted data.
- Eval: `bun run eval:spec-from-attachments` (manual, needs a real key). Not yet run.
