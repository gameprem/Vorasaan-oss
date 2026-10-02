---
status: done
depends-on: [0011, 0013]
slice: install-and-onboarding
---

# 0062: Protect first-run setup with a Setup Token

## Goal
Whoever reaches a fresh, internet-exposed install first can't claim the Admin account. First-run setup needs a one-time Setup Token that only the operator can read, from the server log. Must ship before the first public release.

## Scope
- **Server:** while no Organization exists, startup arms a Setup Token and prints it once, with a ready-made link (`<VORASAAN_WEB_URL>/setup?token=…`), to the server log. An operator may set `VORASAAN_SETUP_TOKEN` instead; then the log only says one is configured.
- `POST /setup/test-ai` and `POST /setup` require the token in the `x-vorasaan-setup-token` header (`SETUP_TOKEN_HEADER` in `@vorasaan/shared`). Missing or wrong: `401` with one generic message. Too many misses: `429`. Already set up: `409`, as before.
- `GET /setup/status` stays public and unchanged: `{ needsSetup }`, never the token.
- Completing setup spends the token.
- **Web:** `/setup` reads `?token=`, prefills a **Setup token** field (also typeable, with the hint "Printed in the server log when it starts: `docker compose logs server`") and sends it with Test connection and Finish setup. A refused token returns the wizard to step 1 with the error.
- **Docs:** README install steps, `.env.example`, `docker-compose.yml` passthrough, CONTEXT.md (Setup Token).

## Acceptance criteria (test first, real Postgres)
- [x] Setup without a token, or with a wrong one, is refused (same message) and creates nothing; a bad body without a token is still `401`, not `400`.
- [x] With the right token setup works once; a second call is `409`; test-ai closes with it.
- [x] Test-ai requires the token and doesn't reach the provider without it.
- [x] The status endpoint never contains the token.
- [x] `VORASAAN_SETUP_TOKEN` works, is never printed, and must be at least 20 characters.
- [x] The token is spent after setup, even if the database is emptied while the server runs.
- [x] Two setups at once with the right token: exactly one Organization, one `201` and one `409` (was a `500`).
- [x] 10 misses from one address in 15 minutes: `429`, even for the right token; a new token starts over.
- [x] Unit tests: the announcement prints the token and link once; constant-time check; limiter per address.
- [x] Full e2e suite passes (global setup seeds the database directly, so no spec runs `/setup`; the e2e server gets a known `VORASAAN_SETUP_TOKEN` anyway).

## Decisions
- **Format.** 24 random bytes (192 bits), base64url: 32 characters, safe in a URL. Only its SHA-256 stays in memory; the plain token is dropped after the one print. Checks hash the candidate and compare with `timingSafeEqual`, so time doesn't depend on how much of it matches.
- **Restarts.** A new token on every start while setup is needed; the old one stops working. Nothing is stored in the database. With several server instances, each would have its own token, so set `VORASAAN_SETUP_TOKEN` there.
- **Printed once,** after "listening", from `main.ts` (`SetupTokenService.announcement()`). No reminder later; `docker compose logs server` keeps it. Tests never print it (they arm tokens directly).
- **Spent, not re-armed.** Setup invalidates the token the moment the Organization's transaction commits. If the database is emptied while the server runs, setup stays closed until a restart prints a new token.
- **Header, not body.** The same header on both routes keeps `AiSettingsInput` unchanged for test-ai. The check is a Nest guard (`SetupTokenGuard`), which runs before body validation, so someone without the token learns nothing about the body.
- **Order of answers.** `409` (already set up) comes before the token check; "already set up" is public through the status anyway.
- **Rate limit,** in memory, per client address: 10 misses per 15 minutes, then `429` before comparing. Defense in depth: 192 bits can't be guessed anyway; it matters for a weak operator-chosen token. Behind the web app every attempt comes from the web server's address, so a flood of wrong tokens there can pause setup through the UI for up to 15 minutes; a restart clears it (new token, new limiter).
- **Leaks.** The token travels only in the header from the web server action to the API; nothing logs it. `/setup` has a `no-referrer` policy (meta tag) and removes `?token=` from the address bar once it's in the field.
- **Concurrent setups.** The serializable transaction already allowed exactly one Organization; the loser now gets `409` instead of a `500` (Prisma `P2034`).

## Left open
- No e2e drives the setup page itself: the e2e server boots on a seeded database, where setup isn't needed. The API tests cover the token.
