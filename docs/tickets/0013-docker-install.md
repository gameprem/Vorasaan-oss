---
status: done
depends-on: [0011]
slice: install-and-onboarding
---

# 0013: One-command install with Docker

## Goal
`docker compose up -d` runs the whole product.

## Scope
- `docker/Dockerfile.server` and `docker/Dockerfile.web` on `oven/bun`.
- Server applies migrations on start.
- Compose: db + server + web (+ optional 9Router profile); `VORASAAN_SECRET_KEY` required.
- README "Install" section.

## Acceptance criteria
- [x] Clean machine: copy `.env.example`, set the secret, `docker compose up -d`, open `/setup`.
