---
status: done
depends-on: [0009, 0010]
slice: install-and-onboarding
---

# 0011: First-boot setup wizard

## Goal
A fresh install opens `/setup`: create the Organization and the first Admin, pick the AI provider, test it, and land signed in.

## Scope
- `GET /setup/status` → `{ needsSetup }` (true while no Organization exists).
- `POST /setup` (only when `needsSetup`): Organization name, Admin name/email/password, AI provider config. One transaction. Signs the Admin in.
- Web `/setup`: step 1 Organization & you, step 2 AI provider (Claude API / OpenAI API / Custom URL + token, model, **Test connection**), step 3 done. Every page redirects to `/setup` while setup is needed.

## Acceptance criteria
- [x] Setup can run exactly once (second call 409).
- [x] A failed provider test blocks nothing but shows the provider's error.
