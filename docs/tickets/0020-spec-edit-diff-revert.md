---
status: done
depends-on: []
slice: mvp-backend
---

# 0020: Spec editing, diff and revert

## Goal
A PO edits the Spec directly, compares any two Spec Versions, and reverts to an earlier one (REQUIREMENT §3.2 Version History).

## Scope
- Manual edit (`POST /features/:id/spec-versions`, exists): restrict to the Feature's PO Role Owners (and Admins); require `baseVersion` and return 409 if the Spec moved on; store a `summary`.
- `GET /features/:id/spec-versions/:version`: one version's Markdown.
- `GET /features/:id/spec-diff?from=&to=`: a line diff of two versions, computed on the server so web and CLI render the same thing.
- `POST /features/:id/spec-versions/:version/revert`: PO Role Owners only. Creates version n+1 with `source: REVERT` and `revertedFromId`. It never deletes versions.
- Spec Versions stay immutable.

## Acceptance criteria (test first, real Postgres)
- [x] A non-PO editing or reverting gets 403; a stale edit gets 409.
- [x] Revert to v1 from v3 creates v4 with v1's Markdown and `revertedFromId` = v1.
- [x] The diff of two versions lists added and removed lines.
