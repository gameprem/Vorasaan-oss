---
status: done
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
- [x] A Thai paragraph is estimated within ±25% of its real token count. The fixture's counts from a real tokenizer are checked in.
- [x] A Feature context made of Thai Specs never goes over its budget when measured with the fixture tokenizer.
- [x] English estimates are unchanged within ±5%.

## Decisions
- **The fixture tokenizer is cl100k_base** (`js-tiktoken`, a dev dependency used only by `bun run --cwd apps/server tokens:fixture`). Of the well-known public tokenizers it is the densest for Thai (about one token per character), and it matches the "two to four times" undercount in ADR 0012; an estimate that holds against it holds for leaner tokenizers too. o200k_base counts are checked in next to it for comparison. The fixture is `apps/server/src/retrieval/token-fixture.ts` (7 Thai, 6 English and 4 mixed Thai-English Spec texts, plus 7 Thai Spec titles); the counts are in `token-fixture.counts.json`. Tests read the counts and never load a tokenizer; a test fails if a text changes without its count being regenerated.
- **Constants** (`apps/server/src/retrieval/token-estimate.ts`): a character in the Thai block (U+0E00 to U+0E7F, vowels and tone marks included) costs 1/0.95 of a token, i.e. 0.95 characters per token; every other character costs a quarter, as before. The ADR's 1.5 would undercount Thai by 27 to 32% against cl100k, so it would not hold a budget. At 1.0 mixed text came out up to 3% under; 0.95 keeps every Thai and mixed sample at or above its real count. One pass over the characters, no tokenizer in the production path.
- **Measured error** (estimate vs real count, min .. max, mean):

  | Text | Old (4 chars/token) | New |
  | --- | --- | --- |
  | Thai, cl100k | -74% .. -71%, mean -72% | +6% .. +16%, mean +12% |
  | Mixed Thai-English, cl100k | -68% .. -56%, mean -62% | +1% .. +8%, mean +4% |
  | English, cl100k | -24% .. +41%, mean +19% | identical to old (0% change) |
  | Thai, o200k (for comparison) | -41% .. -31%, mean -35% | +134% .. +184%, mean +162% |
  | Mixed, o200k (for comparison) | -29% .. -5%, mean -19% | +101% .. +155%, mean +123% |

  So for a model whose tokenizer is as lean as o200k, a Thai budget is used to about 40%. That is the price of a fallback that is never under; the provider's counting API (ADR 0012, ticket 0060) is what makes it exact.
- **Budget test.** A Feature context of seven Thai Specs (`thai-context-budget.api.test.ts`) stays within budgets of 500 to 6,000 tokens measured with the fixture counts. With the old estimate it put 1,051 real tokens in a 500-token budget.
- **Every caller uses it.** `estimateTokens` and `CHARS_PER_TOKEN` moved from `chunker.ts` to `token-estimate.ts`, with `clipToTokens` (`clipForAi` counted in tokens) for every place that cut text to a token budget:
  - retrieval: `blockTokens`, shortening a block to the room left, and the Spec excerpt of the Feature overview (now 200 tokens, was 800 characters);
  - chunking: chunks are sized by the estimate;
  - Project foundation: the Brief cut to `FOUNDATION_BRIEF_TOKENS`, Guideline descriptions (now 75 tokens, was 300 characters);
  - Conversation summaries: `CONVERSATION_LIMITS.maxSummaryTokens` 1,000 (was 4,000 characters), and workflow memory `maxSummaryTokens` 300 (was 1,200 characters).

  For text without Thai each limit cuts exactly where it did. Other character limits (Feature Suggestions' dismissed rationales and Decisions, Attachment summaries) were not counted as tokens and are left as they are.
- **Chunk boundaries change for Thai, so Thai sources are re-embedded.** The chunker now keeps every chunk within `targetTokens` by the new estimate, so Thai text is cut into chunks about four times smaller than before. Text without Thai is cut exactly as before (checked against the old chunker on every English fixture and the large-project fixture at five chunk sizes), so it needs neither re-chunking nor re-embedding. The stale re-index (`POST /settings/embeddings/reindex`, the default scope) now also treats a source as stale when one of its chunks has at least 8 Thai characters and a `tokenCount` no higher than the old one-per-four-characters estimate; re-indexing it re-cuts, re-counts and re-embeds it. Until then, retrieval still holds the budget, because it estimates each block from its text, not from the stored `tokenCount`; an old oversized Thai chunk is skipped when it doesn't fit.
- **Other scripts** (Chinese, Japanese, emoji...) are still counted at four characters per token. Out of scope here; the same table takes another range when a customer needs one.

