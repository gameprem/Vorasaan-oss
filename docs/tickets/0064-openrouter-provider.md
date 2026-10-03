---
status: done
depends-on: [0053, 0060, 0061]
slice: ai-providers
---

# 0064: OpenRouter as an AI Provider

## Goal
An Admin connects OpenRouter with only a key, picks Approved Models from its model list, and gets prompt caching and the right Context Window without typing them (ADR 0010, ADR 0012).

## Scope
- **A new kind:** `OPENROUTER` in `AiProvider` (`packages/shared/src/ai-settings.ts`), next to `ANTHROPIC`, `OPENAI` and `OPENAI_COMPATIBLE`. Its label is "OpenRouter".
  - The Admin enters only a name and the key. The base URL is fixed (`https://openrouter.ai/api/v1`) and not editable; a `baseUrl` for it is a 422, as for the other fixed providers.
  - Today OpenRouter already works as a Custom endpoint with that URL (the README says so). Existing Custom endpoints stay as they are; nothing is migrated.
- **Model list:** adding an Approved Model on an OpenRouter provider loads OpenRouter's `/models` list into the picker, searchable by name and id.
  - Picking a model prefills its Context Window from the list's `context_length` (0060). The Admin can still change it.
  - If the list can't be loaded, the Admin types the model id, as for a Custom endpoint.
- **Calls:** through the OpenAI-compatible route, with the headers OpenRouter asks for: `HTTP-Referer` (the install's public URL) and `X-Title: Vorasaan`.
- **Prompt caching (0061):** for Anthropic models routed through OpenRouter (`anthropic/…` model ids), the stable prefix is marked with `cache_control` in the content parts, with the same 512-token and 4-mark rules. Other models get the plain text, as today. Cache reads and writes are read from OpenRouter's usage fields and logged like the others.
- **Token counting:** the 0059 estimate. OpenRouter has no counting call.
- **Test connection** works for an OpenRouter Approved Model, and a key echoed in an error is masked.

## Acceptance criteria (test first, real Postgres, a fake OpenRouter server)
- [x] An OpenRouter provider is created with a name and a key only; a base URL is refused.
- [x] The model list is loaded and searchable, and a picked model's Context Window is prefilled from `context_length`.
- [x] A Conversation on an `anthropic/…` model via OpenRouter sends the stable prefix with `cache_control` marks and the history unmarked. Any other model via OpenRouter gets no marks.
- [x] Every call sends `HTTP-Referer` and `X-Title: Vorasaan`.
- [x] Cache reads and writes from OpenRouter's usage fields are logged.
- [x] Test connection succeeds against the fake server and reports its error otherwise.
- [x] The key never appears in an API response or a log line.

## Decisions
- **Schema** (migration `20261003120000_openrouter_provider`): `OPENROUTER` added to the `IntegrationProvider` enum, in a migration of its own (a new enum value can't be used in the transaction that adds it). Existing Custom endpoints pointing at OpenRouter are untouched.
- **API contract** (`@vorasaan/shared`):
  - `AiProvider` gained `OPENROUTER` (label "OpenRouter", default name "OpenRouter", no default model). `CreateAiProviderInput` and the setup's `AiSettingsInput` take `{ kind/provider: 'OPENROUTER', name, apiKey }`.
  - A `baseUrl` for OpenRouter is a **422** everywhere: create, `PATCH` (the existing rule for every fixed provider), `POST /setup/test-ai` and `POST /setup` (before anything is written). The schema accepts the field for OpenRouter only so the server can refuse it with a 422 instead of silently dropping it; nothing stores or calls it.
  - `GET /settings/ai/providers/:id/models` (Admin) → `OpenRouterModelsView` `{ models: [{ id, name, contextWindow }], error }`; 422 for a provider of another kind, 404 for an unknown one. `POST /setup/openrouter-models` (Setup Token) returns the same for the wizard. A list that can't be loaded is a 200 with `models: []` and `error` saying why, so the picker can fall back to typing the id.
- **Calls go through Mastra's bundled OpenRouter provider** (`@openrouter/ai-sdk-provider`, inside `@mastra/core`), as the config `{ id: 'openrouter/<model id>', apiKey, headers }`, rather than through Mastra's generic OpenAI-compatible route (`{ providerId, url, ... }`). Both speak OpenRouter's OpenAI-compatible API; the difference is cache marks. The generic route (`@ai-sdk/openai-compatible`) copies `providerOptions.openaiCompatible` onto user content parts, but always sends a system message as one string, so the stable part of a chat's system prompt could not be marked. The OpenRouter provider turns `providerOptions.openrouter.cacheControl` into `cache_control` on the content part, for system blocks and user parts alike, and reads `cache_write_tokens` into the usage. Giving the config a `url` would switch Mastra back to the generic route, so the base URL is not passed: Mastra's OpenRouter provider reads `OPENROUTER_BASE_URL`, else uses `https://openrouter.ai/api/v1`.
- **Base URL.** Fixed at `https://openrouter.ai/api/v1`. `OPENROUTER_BASE_URL` (Mastra's own variable for this provider, so the calls and the model list can't disagree) overrides it for tests; an Admin can never set it. The model list uses the same value, only when it is an http(s) URL, with `redirect: 'error'` and a 10-second timeout. No input from a request ever reaches that URL, so the list is no SSRF path.
- **Headers.** Every call (and the model list) sends `HTTP-Referer` (the origin of `VORASAAN_WEB_URL`, default `http://localhost:3000`; anything that isn't an http(s) URL falls back to the default, and `URL` parsing strips control characters, so nothing can break the header) and `X-Title: Vorasaan`. An env `openrouter/…` model with `OPENROUTER_API_KEY` sends them too.
- **Model list and window.** The picker loads `GET /models` (public: the key is never sent with it), sorted by name, searchable by every word of the search in the name or id, 50 shown at a time. Picking a model fills its id, a display name if empty, and its Context Window from `context_length` (a value outside 4,096 to 10,000,000 is left for the Admin). The Admin can still change the window. When the list can't be loaded, the picker says why and the Admin types the id. The server prefills the same way when no window is given (create, a changed model id, and setup): the list's `context_length`, else the known-model table (which already strips a `provider/` prefix, so `anthropic/claude-…` ids get their Claude window), else the default.
- **Prompt caching (0061).** `cacheMarkOf(model)` replaces the Anthropic-only check: `anthropic/…` on the Anthropic provider gets `providerOptions.anthropic.cacheControl`, `openrouter/anthropic/…` gets `providerOptions.openrouter.cacheControl`, anything else gets the plain text as before. The 512-token and 4-mark rules are the same (`markedUserMessage`, `markedSystem`, formerly `anthropicUserMessage` and `anthropicSystem`). Usage needs no new parsing: the provider reports OpenRouter's `prompt_tokens_details.cached_tokens` and `cache_write_tokens` as `cachedInputTokens` and `cacheCreationInputTokens`, logged by `[AiUsage]` like the others.
- **Token counting** is the 0059 estimate: `countTokens` uses Anthropic's API only for the `ANTHROPIC` provider.
- **Env models.** `VORASAAN_MODEL_<TASK>=openrouter/<model id>` uses the oldest connected OpenRouter provider's key, else `OPENROUTER_API_KEY`, like `anthropic/…` and `openai/…`.
- **Keys in logs.** Mastra logs a failed provider call with the provider's response body, which may echo the key. Every Agent now logs through a `RedactingLogger` (a Mastra `ConsoleLogger`) that masks the call's key, for every provider, not just OpenRouter. Test connection masks it in its result, as before.
- **Web.** OpenRouter is a fourth kind in Settings → AI models and in the setup wizard's provider step (name and key only, no URL field). With an OpenRouter provider selected, "Add a model" and "Edit" show the searchable list above the model id; the setup wizard shows it too (the server prefills the window there).
- **Tests.** `openrouter.test.ts` (MastraAiPort against a local stand-in for OpenRouter, `src/test/fake-openrouter.ts`: an `anthropic/…` task and chat marked, history unmarked, other models unmarked with the same text, the headers on every call, cache usage logged, the estimate for counting, Test connection ok and failing with the key masked in Mastra's log, the model list and its failures, the base URL and header rules), `openrouter-settings.api.test.ts` (create with a key only, 422 for a URL, the list and window prefill, the fallback, 422/403/404 on the list, the choice of model, Test connection through the API with the echoed key masked, no key in any response, env models, setup with OpenRouter and its 422), `prompt-cache.test.ts` (`cacheMarkOf`, OpenRouter marks), `model-config.test.ts`, the picker's search (`openrouter-model-picker.test.ts`) and `e2e/openrouter-settings.e2e.ts` (connect, search, pick, the window shows "200k tokens", the fallback message), against a fake OpenRouter on `E2E_FAKE_OPENROUTER_PORT`.
- **Manual check (not done here: no OpenRouter key in this environment).**
  1. Settings → AI models → Connect a provider → OpenRouter, with a real key. Add a model: the list loads; search for an Anthropic model, pick it, and see its window filled in. Test it.
  2. On a Project with a Brief of a few paragraphs and a Feature with a Spec, open a Feature Conversation on that model and send two messages within 5 minutes. The server log shows `[AiUsage] chat: … (cache read 0, cache write N)` then `cache read M` with M > 0. OpenRouter's Activity page shows the calls as "Vorasaan".
  3. Pick a non-Anthropic model the same way and check a reply works (its log line has no cache write).
- **Left open.** OpenRouter's usage arrives in the final stream chunk without `stream_options` (OpenRouter always includes it); if a proxy strips it, the log shows `?`. The list is fetched on each form open and each window prefill, with no cache: Admin actions are rare. Fixed providers other than OpenRouter still drop a `baseUrl` on create silently, as before (only `PATCH` refuses it).
