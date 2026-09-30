---
status: done
depends-on: []
slice: install-and-onboarding
---

# 0009: AI providers from the database

## Goal
An Admin chooses the LLM provider in the app, not in env vars: **Claude API**, **OpenAI API** (incl. Codex models), or **a custom OpenAI-compatible URL + token** (e.g. 9Router, which can front a Codex subscription).

## Scope
- Prisma: add `OPENAI` to `IntegrationProvider`; add `model` to `OrgIntegration`.
- Encrypt secrets at rest (AES-256-GCM) with `VORASAAN_SECRET_KEY`.
- `AiPort` resolves the Organization's default LLM integration on every call (so changes apply without restart), falling back to env config for dev.
- Provider → Mastra model config: `anthropic/<model>` + key, `openai/<model>` + key, `{ providerId: 'custom', modelId, url, apiKey }`.
- `POST /settings/ai/test`: a tiny structured call to check a config before saving.
- `GET/PUT /settings/ai` (Admin only; never returns the secret, only its last 4 chars).

## Acceptance criteria
- [x] Encryption round-trips; ciphertext never contains the plaintext; wrong key fails.
- [x] Each provider maps to the right Mastra model config (unit tests).
- [x] Saving a new provider takes effect on the next request without restart.
