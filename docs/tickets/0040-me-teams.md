---
status: done
depends-on: []
slice: mvp-polish
---

# 0040: `GET /me/teams`

## Goal
Pages that need "my Teams and my Team Roles" load them in one request instead of fetching every Team in the Organization (follow-up from #45).

## Scope
- `GET /me/teams` returns the signed-in user's Teams, each with its Project, the user's Team Roles there, and the Team's members with their Team Roles.
- Settings → Delegations and the CLI Features/raise pickers use it.

## Acceptance criteria (test first, real Postgres)
- [x] Returns only the caller's Teams, with their roles and members; another user's Teams never appear.
- [x] Settings → Delegations makes one request for Teams instead of one per Team.
