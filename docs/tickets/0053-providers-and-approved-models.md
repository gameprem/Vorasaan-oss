---
status: done
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
- [x] After migration, an existing install works unchanged: one provider, its model as the default.
- [x] With Anthropic and an OpenAI-compatible provider connected, each Approved Model's calls go to its own provider.
- [x] A non-Admin gets 403 on the settings routes, and `GET /ai/models` never returns a key or a base URL.
- [x] Deleting the default is refused until another model is made the default.

Tests: `apps/server/src/settings/ai-settings.api.test.ts` (the routes, the model of each call through a real Decision Request and Conversation, env overrides, Test), `apps/server/src/ai/approved-models.migration.test.ts` (an install with the old shape is migrated in a scratch database, then every task runs on its model with its key), `apps/server/src/setup/setup.api.test.ts`, and `apps/server/src/ai/model-config.test.ts`.

## Decisions
- **Schema** (migration `20261001170000_approved_models`):
  - `OrgIntegration` gained `name` (the Admin's label) and lost `isDefaultLlm`. Its `(organizationId, provider)` unique became a partial unique index on `ATLASSIAN` and `EMBEDDINGS` only, so LLM providers can be several, even of one kind (two custom endpoints). The Atlassian and embeddings settings now find and save their row by kind instead of `upsert` on the old key. `model` is now only for `EMBEDDINGS`.
  - `ApprovedModel`: `integrationId`, `modelId`, `displayName` (unique per Organization), `note`, `position`, `isDefault`. A partial unique index allows at most one default; the service keeps exactly one (the first model is always the default, the default can't be unset or deleted, and a provider with models can't be deleted, so the last model can never go).
  - `AiTaskModel` (`organizationId`, `task`, `approvedModelId`, unique per task): the model set for a task. No row means the default. Removing the model cascades the row, so the task falls back to the default.
  - The FK from `ApprovedModel` to its provider is `NO ACTION`, not `RESTRICT`, so deleting an Organization (which cascades to both) still works.
- **Migration**: every LLM integration is named after its kind ("Anthropic", "OpenAI", "Custom endpoint"). The default one's model becomes the default Approved Model, named after the model id (e.g. "claude-opus-5-5"), so the Admin can rename it. Providers that weren't the default stay connected but get no Approved Model: nobody could use them before, so nobody can now. `model` is cleared on LLM integrations. An install with no default LLM integration gets no Approved Model and keeps using env, as before.
- **Settings tasks**: the seven the ticket lists (`AiTaskKind`: CHOICES, SPEC_PROPOSAL, SUMMARIES, GRILLING, FEATURE_SUGGESTIONS, FIT_CHECK, CHAT). The eleven AI calls map onto them (`AI_TASKS` in `ai.config.ts`): the three Spec drafts (after a Decision, from Attachments, from a Feature Suggestion) are SPEC_PROPOSAL; Attachment and Conversation summaries are SUMMARIES; Grilling questions and the Brief drafted from them are GRILLING. The env vars stay one per call.
- **Choosing the model of a call** (`AiSettingsService.chooseModel`), in order:
  1. the Approved Model the caller picked (`options.approvedModelId`), when it still exists; otherwise it falls through (0054 adds the notice);
  2. the call's `VORASAAN_MODEL_<TASK>` env var, when set. This wins over Settings, as ADR 0010 says. Before, a configured provider made every env var ignored; an install that set both now gets the env var for that task;
  3. the task's Approved Model in Settings;
  4. the default Approved Model;
  5. with no Approved Model at all, `VORASAAN_MODEL` (default `anthropic/claude-opus-5-5`), as before setup today. `VORASAAN_MODEL` alone never overrides Settings, so an existing install that sets it keeps its configured provider.
  - An env model `anthropic/…` or `openai/…` uses the key of the oldest connected provider of that kind, else the env key (`ANTHROPIC_API_KEY`…). So a Docker install can override a task without putting a key in env.
- **AiPort**:
  - Every method takes an optional last `options: AiCallOptions` (`{ approvedModelId?, model? }`). Callers don't change; 0054 passes `approvedModelId` for the chat picker.
  - `AI_PORT` is now `ModelRoutingAiPort`: before each call it chooses the model (a `ModelChoice`: source APPROVED_MODEL or ENV, the Approved Model and provider ids, the provider config with its decrypted key, and the model name) and passes it as `options.model` to the engine (`AI_ENGINE`). A chat reply chooses once, before its first chunk, so nothing switches provider mid-reply.
  - `AI_ENGINE` is `MastraAiPort` (or `FakeAiPort` with `VORASAAN_AI=fake`). `MastraAiPort` builds the Mastra model from `options.model` and refuses a call without one; the eval scripts still pass their own env resolver.
  - Tests override `AI_ENGINE` (not `AI_PORT`), so routing runs for real and `FakeAiPort.calls[]` records `model` with each call.
- **API** (`packages/shared/src/ai-settings.ts`), Admin only under `/settings/ai`:
  - `GET /settings/ai` → `AiSettingsView` (`providers`, `models`, `tasks` with each task's `envOverrides`), the whole page in one call. `GET /settings/ai/providers` and `GET /settings/ai/models` return one part each.
  - `POST /settings/ai/providers` (`kind`, `name`, `apiKey`, `baseUrl` for OPENAI_COMPATIBLE) → 201; `PATCH /settings/ai/providers/:id` (`name`, `baseUrl`, `apiKey`; a left-out key keeps the stored one; a base URL on a non-custom provider is a 422); `DELETE` → 204, or 409 while Approved Models run on it.
  - `POST /settings/ai/models` (`providerId`, `modelId`, `displayName`, `note`, `isDefault`) → 201; the first model is the default whatever `isDefault` says. `PATCH /settings/ai/models/:id` (same fields, `isDefault: true` only); `DELETE` → 204, or 409 for the default. A duplicate display name is a 409; a provider that isn't an LLM provider is a 404.
  - `POST /settings/ai/models/:id/test` → `AiTestResult`, a tiny real call as before. A key the provider echoes in its error is masked.
  - `PUT /settings/ai/tasks` (`{ tasks: { CHAT: id | null, … } }`) → `AiSettingsView`; only the tasks given change, `null` means the default, an unknown model is a 422.
  - `GET /ai/models` (any signed-in member) → `{ models: [{ id, displayName, note, isDefault }] }`: no provider, key or URL.
  - The old `PUT /settings/ai` and `POST /settings/ai/test` are gone. Setup keeps its input (`provider`, `model`, `baseUrl`, `apiKey`) and `POST /setup/test-ai`; it now creates the first provider and the default Approved Model.
- **No reordering yet**: `position` is set at creation (after the last). Nothing needs another order before the chat picker (0054).
- **Keys**: encrypted with `VORASAAN_SECRET_KEY` as before; views show only the last four characters; nothing logs a `ModelChoice`.
- **Web**: Settings → "AI models" (was "AI provider") lists providers (connect, edit name/URL/key, remove), Approved Models (add, edit, Test, Make default, remove; the default has a badge and no Remove), and a model per task (a select per task with "Default (name)", and a warning when an env var overrides it). Same look as the other settings pages. The setup wizard is unchanged apart from its copy.
- **Not here**: `Conversation.modelId`, the chat picker, and recording the model on messages and proposals (0054).
