---
status: done
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
- [x] A PO of one of the Project's Teams edits the Brief to v1 and then v2. A Member gets 403. A stale edit gets 409.
- [x] Revert creates the next version. The diff lists added and removed lines.
- [x] A Project Attachment snapshots like a Feature Attachment, and its permissions follow the Brief's.

## Notes
- No Brief Version exists until someone saves: `GET /projects/:id/brief` returns the template as version 0, and the first edit uses `baseVersion: 0`.
- Brief Proposals are reviewed by their named approver, who must still be an editor (Admin or PO of one of the Project's Teams). Nothing creates them yet (Grilling is 0032); they are not Inbox Items yet (left for 0035).
- Project Attachments' chunks have no Feature, so every Feature of the Project retrieves them; only the latest Brief Version is indexed (`BRIEF_VERSION`).
