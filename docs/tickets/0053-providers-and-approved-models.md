---
status: todo
depends-on: []
slice: chat-web-ui
---

# 0053: Several providers and Approved Models

## Goal
An Organization connects several AI providers and decides which models people may use (ADR 0010).

## Scope
- **Providers:** several LLM `OrgIntegration`s per Organization, each with its own encrypted key and, for OpenAI-compatible endpoints, a base URL.
  - The existing single provider is migrated as the first one.
- **Approved Models:** `ApprovedModel` has a provider integration, a model id, a display name, an optional note, a position, and `isDefault`.
  - Exactly one model is the default.
  - Migration: the current provider's model becomes the default Approved Model.
- **Per AI task:** the model for each task (Choices, Spec Proposal, summaries, Grilling, Suggestions, fit check, chat) is chosen from the Approved Models, with the default as the fallback.
  - `VORASAAN_MODEL_*` still overrides when it is set.
- **API:**
  - CRUD under `/settings/ai/providers` and `/settings/ai/models`, Admin only.
  - `GET /ai/models` lists display names and notes for every member. It never includes keys.
  - "Test" checks one Approved Model with a short call, the way the current test does.
- **AiPort:** the model is chosen per call, from the provider and model id. The `FakeAiPort` records which model it was asked for.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] After migration, an existing install works unchanged: one provider, its model as the default.
- [ ] With Anthropic and an OpenAI-compatible provider connected, each Approved Model's calls go to its own provider.
- [ ] A non-Admin gets 403 on the settings routes, and `GET /ai/models` never returns a key or a base URL.
- [ ] Deleting the default is refused until another model is made the default.
