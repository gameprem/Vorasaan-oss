---
status: todo
depends-on: [0060]
slice: context
---

# 0061: Prompt caching for the stable prefix

## Goal
Long Conversations and repeated AI calls cost less and answer faster (ADR 0012).

## Scope
- Order every prompt as stable to volatile: system prompt, then Project Brief and Guidelines, then the Feature's Spec, then retrieved chunks, then history, then the new message.
- Mark the stable prefix for caching on providers that support it (Anthropic cache control; the OpenAI automatic prefix cache needs only the ordering). Leave other providers unchanged.
- Record cache hits per call (from the provider's usage fields) in the server log, and in the Decision Lead Time / AI usage view if one exists by then.

## Acceptance criteria
- [ ] Unit tests: the Anthropic adapter marks the prefix and leaves volatile parts unmarked. Other adapters send the same text as before.
- [ ] Manually verified against a real Anthropic key: the second turn of a Conversation reports cache reads.
