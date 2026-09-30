---
status: todo
depends-on: [0034]
slice: project-foundation
---

# 0035: Web: Project Brief, Grilling, Guidelines and Suggestions

## Goal
Everything in 0030–0034 is usable in the web app.

## Scope
- **Project page:** Brief (rendered, with the editor for POs and Admins), Brief history with diff and revert, Project Attachments.
- **Grilling:** start it; a question-and-answer view per round for the people asked; review the proposal diff and approve it.
- **Settings → Feature Guidelines** (Admins) and **Project → Guidelines** (overrides, showing where each criterion comes from).
- **Suggestions tab:** generate, then accept (pick a Team) or dismiss (with a reason).
- **Creating a Feature:** the Guidelines checklist and the fit-check result before saving.
- Grilling questions waiting for me appear in the Inbox.

## Acceptance criteria
- [ ] Browser-verified (Playwright): Grilling on an empty Project → Brief v1 → generate Suggestions → accept one → the new Feature has a Spec Proposal to approve.
- [ ] Loading, empty and error states for every new view.
