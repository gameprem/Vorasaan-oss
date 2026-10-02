---
status: todo
depends-on: []
slice: context
---

# 0059: Count tokens correctly for Thai

## Goal
Context budgets hold for Thai content, not only English (ADR 0012).

## Scope
- Replace the single `CHARS_PER_TOKEN = 4` estimate with a script-aware estimate. Thai is about 1.5 characters per token and Latin text about 4; tune these against real tokenizer counts and record the numbers in Decisions. Every caller of `estimateTokens` (retrieval, chunking, project foundation, conversation summaries) uses it.
- Re-chunk on the next index pass: `tokenCount` is stored on chunks, so Thai chunks must be re-estimated. No re-embedding is needed unless chunk boundaries change; say in Decisions whether they do.
- Measure it: a small fixture of Thai, English and mixed Spec text, compared with a real tokenizer offline, with the error recorded in the ticket.

## Acceptance criteria (test first)
- [ ] A Thai paragraph is estimated within ±25% of its real token count. The fixture's counts from a real tokenizer are checked in.
- [ ] A Feature context made of Thai Specs never goes over its budget when measured with the fixture tokenizer.
- [ ] English estimates are unchanged within ±5%.
