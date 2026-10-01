---
status: todo
depends-on: []
slice: mvp-polish
---

# 0038: POs can read the Organization's default Feature Guidelines

## Goal
A PO editing a Project's Guideline overrides sees the text of every inherited criterion, including ones the Project hides (follow-up from #46).

## Scope
- `GET /settings/feature-guidelines` becomes readable by every member of the Organization; `PUT` stays Admin only.
- The Project → Guidelines editor shows a hidden inherited criterion's title and text instead of the "An Organization criterion hidden in this Project" placeholder.

## Acceptance criteria (test first, real Postgres)
- [ ] A Member gets 200 on `GET` and 403 on `PUT`; an Admin can do both.
- [ ] Browser-verified: a non-Admin PO sees the hidden criterion's text in the Project overrides editor.
