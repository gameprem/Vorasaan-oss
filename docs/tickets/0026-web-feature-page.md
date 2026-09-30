---
status: todo
depends-on: [0020, 0021, 0023]
slice: mvp-web
---

# 0026: Web: Feature page with editor, history, diff, Attachments

## Goal
The Feature page is the single overview of REQUIREMENT §3.2.

## Scope
- BlockNote Spec editor that loads and saves Markdown (ADR 0002), for PO Role Owners; others read rendered Markdown.
- Version History: version, source, approver, summary and date. Diff any version against the previous one; PO can revert.
- Decision Log tab (exists): add "on behalf of".
- Attachments panel: upload, add URL/Confluence/Jira, refresh, delete, view Snapshot.
- "Draft Spec from Attachments" for POs → opens the proposal review.
- Blocked badge while any Blocker is open; open Questions don't count. The same badge in Feature lists.

## Acceptance criteria
- [ ] Browser-verified: edit in BlockNote → v2 saved as Markdown that round-trips; diff v1↔v2; revert to v1 creates v3.
- [ ] Browser-verified: upload a Markdown file, draft a Spec from it, approve.
