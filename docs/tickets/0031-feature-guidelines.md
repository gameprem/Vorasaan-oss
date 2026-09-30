---
status: done
depends-on: [0030]
slice: project-foundation
---

# 0031: Feature Guidelines

## Goal
The business states what a good Feature must satisfy, once for the Organization and adjusted per Project (REQUIREMENT §3.8).

## Scope
- Guidelines are a list of criteria, each with:
  - a title,
  - a description,
  - a kind: KPI, CONSTRAINT or REQUIRED_SECTION,
  - `required` (true or false).
- Stored as an Organization default and, per Project, overrides: add a criterion, disable an inherited one, or edit its text. No Markdown blob, so the AI and the UI can check criteria one by one.
- API:
  - `GET/PUT /settings/feature-guidelines` (Admins).
  - `GET/PUT /projects/:id/feature-guidelines` (the Project's POs and Admins).
  - `GET /projects/:id/feature-guidelines/effective` (everyone in the Organization): the merged result, with where each criterion came from.
- Migration for the tables.

## Acceptance criteria (test first, real Postgres)
- [x] The effective list is the Organization default plus the Project's additions, minus what it disabled, with its edits applied.
- [x] Only Admins change the default. Only the Project's POs or Admins change the overrides.
