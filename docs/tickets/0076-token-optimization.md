---
status: todo
depends-on: [0068, 0071, 0075]
slice: performance
---

# 0076: Token optimization with an eval guard

## Goal
Each AI task uses fewer tokens without answering worse.

## Scope
Try each change on its own, measure tokens per task from Receipts (0070, 0075) and scores from the evals (0071):
- **Trim prompts:** remove repeated or unused instructions in `packages/skills`.
- **Retrieval top-k:** tune how many chunks each workflow retrieves within its budget (0060).
- **Deduplicate context:** don't send the same chunk, Spec section or Brief text twice in one call.
- **Order for cache hits:** move more stable material before the cache break (0061) where it is safe.
- **Cheaper models for simple tasks:** suggest to the Admin an Approved Model per task (for example summaries on "Fast") where its eval scores hold. The Admin decides; nothing is switched by itself.

**The guard:** a change is kept only if tokens per task go down and eval scores don't go down, including the Thai cases (0068) and the replay of approved Receipts (0071). Any change that lowers a score is not kept.

## Acceptance criteria (test first where it applies)
- [ ] Unit tests: deduplication removes a repeated chunk, and the prompt order keeps the stable prefix first.
- [ ] For every kept change, tokens per task are lower and every eval score (including Thai and replay) is not lower; runs on a real model are manual.
- [ ] A report in this ticket's Decisions lists each change tried, its token saving and its scores, and whether it was kept.
