---
status: todo
depends-on: []
slice: project-foundation
---

# 0030: Project Brief and Project-level Attachments

## Goal
Each Project has a versioned, human-approved Project Brief, and documents can be attached to the Project as well as to a Feature (REQUIREMENT §3.8, ADR 0006).

## Scope
- Migration:
  - `BriefVersion` (projectId, version, markdown, source: MANUAL | GRILLING | REVERT, summary, approvedById, revertedFromId).
  - `BriefProposal` (PENDING → APPROVED/REJECTED, baseVersionId, approverId).
  - `Attachment` gets an optional `projectId`; exactly one of `featureId`/`projectId` is set.
- API, mirroring Spec (0020): read the current Brief, list versions, one version, diff, manual edit with `baseVersion` (409 when stale), revert.
  - Editors are Admins and the POs of the Project's Teams. Everyone in the Organization can read.
- Brief Proposals: approve and reject, with the same stale-base 409 as Spec Proposals.
- Project Attachments reuse the 0021 endpoints and snapshotters under `/projects/:id/attachments`.
- A new Project starts with an empty Brief template (section headings only).

## Acceptance criteria (test first, real Postgres)
- [ ] A PO of one of the Project's Teams edits the Brief to v1 and then v2. A Member gets 403. A stale edit gets 409.
- [ ] Revert creates the next version. The diff lists added and removed lines.
- [ ] A Project Attachment snapshots like a Feature Attachment, and its permissions follow the Brief's.
