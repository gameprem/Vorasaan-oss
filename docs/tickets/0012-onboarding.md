---
status: todo
depends-on: [0011]
slice: install-and-onboarding
---

# 0012: Projects, Teams, members and Features in the web app

## Goal
Everything the seed script did can be done in the UI.

## Scope
- Admin: create Projects (with optional Jira key) and Teams.
- Invite members: Admin creates an invitation and **copies a link** (no email server needed); the invitee sets name + password.
- Team membership with Team Roles (several per person).
- Features: create in a Team, set Role Owners (several per role), write Spec v1 (Markdown editor with preview).
- Navigation: Projects → Teams → Features; Inbox stays the home page.

## Acceptance criteria
- [ ] From an empty install: setup → invite a Backend dev → create a Feature with Spec v1 → the dev raises from the CLI → the PO decides in the web app.
- [ ] Non-admins can't create Projects/Teams or invite (403).
