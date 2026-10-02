---
status: done
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
- [x] Browser-verified (Playwright): Grilling on an empty Project → Brief v1 → generate Suggestions → accept one → the new Feature has a Spec Proposal to approve.
- [x] Loading, empty and error states for every new view.

## Decisions
- **One Project page** (`/projects/[id]`, tabs Brief, History, Attachments, Grilling, Guidelines, Suggestions) is where the `ANSWER_GRILLING` and `APPROVE_BRIEF_PROPOSAL` Inbox Items land (`?tab=grilling#current-round` / `#brief-proposal`). It shows the latest Grilling, by its `status` (an ASKING round of a cancelled one reads "Stopped when cancelled"), and every pending Brief Proposal above it.
- **Reuse over copies:** the Spec editor, `RevertButton` and `ReviewProposal` take the save/revert/approve actions as props, so the Brief uses the same BlockNote editor, diff and review UI. The Attachments panel and its upload bridge take an owner (`features` or `projects` plus a UUID), with one route handler per owner kind sharing the same Origin, size and UUID checks.
- **No server change.** Only Admins may read the Organization default (0031), so a PO editing a Project's overrides sees a criterion the Project hides as "An Organization criterion hidden in this Project" (without its text); Admins see its title.
- Accepting a Feature Suggestion offers the Project's Teams where the viewer may manage Features (Admin, or PO of that Team); the API still decides.

