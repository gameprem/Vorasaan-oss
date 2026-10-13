---
status: in-progress
depends-on: [0053, 0060, 0061, 0064, 0070, 0075]
slice: ai-providers
---

# 0080: Gemini as an AI Provider

## Goal
An Admin connects the Gemini API with only a key from Google AI Studio, picks Approved Models from Gemini's model list, and gets the right Context Window and Gemini's own prompt caching without typing them (ADR 0010, ADR 0012), the way OpenRouter works (0064).

## Scope
- **A new kind:** `GEMINI` in `AiProvider` (`packages/shared/src/ai-settings.ts`), next to `ANTHROPIC`, `OPENAI`, `OPENAI_COMPATIBLE` and `OPENROUTER`. Its label is "Gemini API"; its default name "Gemini".
  - The Admin enters only a name and the key, encrypted with `VORASAAN_SECRET_KEY` like every provider key. The base URL is fixed (`https://generativelanguage.googleapis.com/v1beta`) and not editable; a `baseUrl` for it is a 422, as for OpenRouter.
- **Calls:** through the AI SDK's Google provider (`@ai-sdk/google`), the version Mastra bundles, so no new dependency; the key in the `x-goog-api-key` header only.
- **Model list:** adding an Approved Model on a Gemini provider loads Gemini's `GET /models` (read with the provider's key) into the picker, only the models that generate text, searchable by name and id.
  - Picking a model prefills its Context Window from the list's `inputTokenLimit` (0060). The Admin can still change it.
  - If the list can't be loaded, the Admin types the model id; the window falls back to the known-model table, else the default.
  - The setup wizard lists the models too, for the key typed there.
- **Prompt caching (0061):** Gemini caches a repeated prefix by itself (implicit caching), so it gets the stable-first prompt as it is, with no marks. Cached tokens from Gemini's usage are logged and recorded on Receipts (0070) and in the AI usage dashboard (0075).
- **Structured output and tool calls** work for every AiPort task and the chat tools, within the JSON schema subset Gemini accepts.
- **Token counting:** the 0059 estimate.
- **Embeddings (ADR 0007):** decide whether Gemini embeddings fit the current EMBEDDINGS design.
- **Test connection** works for a Gemini Approved Model, and a key echoed in an error is masked.

## Acceptance criteria (test first, real Postgres, a fake Gemini API)
- [ ] A Gemini provider is created with a name and a key only; a base URL is refused.
- [ ] The model list is loaded with the provider's key and searchable, and a picked model's Context Window is prefilled from `inputTokenLimit`; a list that can't be loaded falls back to typing the id.
- [ ] A task and a chat on a Gemini model send the prompt unmarked, with structured output and tools in the schema subset Gemini accepts.
- [ ] Cached tokens from Gemini's usage are logged and reach the Receipt.
- [ ] Test connection succeeds against the fake API and reports its error otherwise, with the key masked.
- [ ] The key never appears in an API response, a URL or a log line.
