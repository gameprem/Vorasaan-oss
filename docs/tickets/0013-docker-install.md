---
status: todo
depends-on: [0011]
slice: install-and-onboarding
---

# 0013: One-command install with Docker

## Goal
`docker compose --profile app up` runs the whole product.

## Scope
- `docker/Dockerfile.server` and `docker/Dockerfile.web` on `oven/bun`.
- Server applies migrations on start.
- Compose: db + server + web (+ optional 9Router profile); `VORASAAN_SECRET_KEY` required.
- README "Install" section.

## Acceptance criteria
- [ ] Clean machine: copy `.env.example`, set the secret, `docker compose --profile app up`, open `/setup`.
