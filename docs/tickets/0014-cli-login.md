---
status: done
depends-on: [0010]
slice: install-and-onboarding
---

# 0014: CLI sign-in with a Personal Access Token

## Goal
Developers use their own identity in the CLI.

## Scope
- `vorasaan login --url <server>`: prompts for a PAT (created in the web app), verifies it with `GET /me`, stores it in `~/.config/vorasaan/config.json` (0600).
- `vorasaan logout`, `vorasaan whoami`.
- The API client sends `Authorization: Bearer`. `VORASAAN_USER` stays as a dev fallback.

## Acceptance criteria
- [x] login → whoami → raise works against a server without dev auth.
