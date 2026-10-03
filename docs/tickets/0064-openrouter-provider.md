---
status: todo
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
- [ ] An OpenRouter provider is created with a name and a key only; a base URL is refused.
- [ ] The model list is loaded and searchable, and a picked model's Context Window is prefilled from `context_length`.
- [ ] A Conversation on an `anthropic/…` model via OpenRouter sends the stable prefix with `cache_control` marks and the history unmarked. Any other model via OpenRouter gets no marks.
- [ ] Every call sends `HTTP-Referer` and `X-Title: Vorasaan`.
- [ ] Cache reads and writes from OpenRouter's usage fields are logged.
- [ ] Test connection succeeds against the fake server and reports its error otherwise.
- [ ] The key never appears in an API response or a log line.
