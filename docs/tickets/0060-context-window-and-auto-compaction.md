---
status: todo
depends-on: [0059]
slice: context
---

# 0060: Context budgets from the model, and auto-compaction

## Goal
Every AI call fits the model it runs on, and long Conversations keep going without forgetting what was agreed (ADR 0012).

## Scope
- **Window:** `ApprovedModel.contextWindow`, prefilled for known models and editable in Settings → AI models. An env model uses a default that can be configured.
- **Counting:** the provider's token-counting API where available, with the 0059 estimate as fallback. Count once per turn, never per chunk.
- **Budgets:** each workflow's budget becomes a share of the window:
  - foundation and system prompt
  - retrieved context
  - history
  - room for the reply
  
  Each share has a floor, and the shares and floors live in one config. The retrieval order from ADR 0007 is unchanged.
- **Auto-compaction** of Conversations replaces the 12-message rule:
  - Compact when the history passes ~70% of its share. Keep the newest turns word for word.
  - Fold the rest into a structured summary: goal, agreed, open questions, pending Action Cards, preferences, key names/numbers/ids. The prompt lives in `packages/skills`, with eval cases including Thai.
  - Before folding, the AI may propose an Action Card for anything agreed but not yet recorded in the Spec or the Brief.
- **Compact and retry:** when a provider rejects a request as too long, compact and retry once. Report the error only if the retry fails too.
- **Web:** a quiet "Earlier messages were summarized" marker in the thread. It expands to the original messages, which stay stored.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] With an 8k-window model, a Feature turn's prompt (measured by the fake's counter) stays under the window. With a 200k model, the same turn retrieves more context.
- [ ] A Conversation of a few very long Thai messages compacts before it overflows. The summary keeps an agreed point and an id from early in the chat.
- [ ] A scripted "too long" error from the provider triggers one compaction and a successful retry. A second failure is a 502, and no half reply is stored.
- [ ] Browser-verified: the marker shows and expands to the original messages.
