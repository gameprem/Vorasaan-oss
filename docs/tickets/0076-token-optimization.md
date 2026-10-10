---
status: done
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
- [x] Unit tests: deduplication removes a repeated chunk, and the prompt order keeps the stable prefix first.
- [x] For every kept change, tokens per task are lower and every eval score (including Thai and replay) is not lower; runs on a real model are manual.
- [x] A report in this ticket's Decisions lists each change tried, its token saving and its scores, and whether it was kept.

## Decisions

### How tokens and scores are measured (no real model here)
- **The exact prompt, measured.** `TASK_PROMPTS` (`apps/server/src/ai/prompts.ts`) is now the one place a call's input becomes its prompt; `MastraAiPort` renders through it. `measuringAiPort` (`src/evals/prompt-tokens.ts`) wraps the `FakeAiPort`, renders every call's prompt as a provider would get it (language rules, active Prompt Version, tools and messages for chat), sizes it with the 0059 estimate, and reports that as the call's usage, so its **Receipt carries the tokens** (`createTestApp({ engine })`). It also reports what can be cached: the prefix through the last marked cut (0061).
- **`bun run tokens:tasks`** (`scripts/token-report.ts`): (1) every checked-in eval case (0071), Thai and mixed included, with its prompt tokens and its score on the fake; (2) the product's own calls on the small large Organization (0073, re-seeded each run in `TOKENS_DATABASE_URL`, default `vorasaan_tokens_bench`): a Decision Request with Choices, a Choices Redraft, a Decision, its Spec Proposal and a Redraft, a second request decided as drafted, three Feature Conversation turns and a Project one, a Spec from Attachments, Feature Suggestions with a Redraft and an accepted one, the fit check and a Grilling round, with three Guidelines; tokens per task are read **from the Receipts**; (3) the **replay** of the approved Receipts (generate-choices, draft-spec-proposal), scored as 0071 does; (4) whether retrieval still finds the large-project needle. `--out` keeps JSON, `--compare` prints before/after and every lower score (exit 1).
- **The guard in tests**, like 0074's query budgets (`src/evals/token-guard.ts`): `token-guard.test.ts` (no database) fails when a task's checked-in cases cost more tokens or score less (Thai apart) than recorded; `token-scenarios.api.test.ts` (real Postgres) fails when a task's product calls send more tokens per call, the replay scores less, or the needle is lost, and checks every Receipt carries its measured prompt.
- **What the fake can and can't show.** The fake doesn't read prompts, so its scores only prove structure: valid answers, kept texts and language checks on its canned output, injections not followed, the replay's similarity, the needle retrieved. That a real model answers as well with less context is **not** measured here (no key in this environment): see "Verify with a real model" below.

### Each change, on its own, against the baseline
Tokens per call of the product's calls (mean, from Receipts), each change measured alone on the same seeded data (the others switched off), then all together. Scores: every checked-in case and the replay scored the same in every run (no lower score anywhere); the needle was found in every run.

| Task | Before | Dedupe only | Top-k only | Prompts only | All kept |
| --- | ---: | ---: | ---: | ---: | ---: |
| generateChoices | 13,314 | 13,355 | 10,822 | 13,282 | 9,370 (-29.6%) |
| draftSpecProposal | 13,148 | 13,039 | 10,286 | 13,134 | 9,057 (-31.1%) |
| draftSpecFromAttachments | 31,016 | 27,824 | 31,016 | 31,001 | 27,809 (-10.3%) |
| grillingQuestions | 8,531 | 7,892 | 8,531 | 8,531 | 7,892 (-7.5%) |
| suggestFeatures | 10,719 | 7,992 | 10,719 | 10,719 | 7,992 (-25.4%) |
| draftSpecFromSuggestion | 8,393 | 7,755 | 8,393 | 8,393 | 7,755 (-7.6%) |
| checkFeatureFit | 8,397 | 7,759 | 7,011 | 8,397 | 6,557 (-21.9%) |
| chat | 12,734 | 12,600 | 10,959 | 12,723 | 10,034 (-21.2%) |
| redraftChoices | 13,557 | 13,528 | 10,994 | 13,557 | 9,127 (-32.7%) |
| redraftSpecProposal | 13,429 | 13,388 | 10,659 | 13,420 | 9,335 (-30.5%) |
| redraftFeatureSuggestion | 8,615 | 7,977 | 8,615 | 8,615 | 7,977 (-7.4%) |
| Replay generate-choices: tokens / score | 13,205 / 96.0% | 13,247 / 96.0% | 10,781 / 96.0% | 13,173 / 96.0% | 9,329 / 96.0% |
| Replay draft-spec-proposal: tokens / score | 13,054 / 99.0% | 13,014 / 99.0% | 10,272 / 99.0% | 13,040 / 99.0% | 9,044 / 99.0% |

Checked-in eval cases (mean prompt tokens before → after; scores on the fake unchanged for every task, Thai included): generateChoices 1,633 → 1,602; summarizeAttachment 868 → 863; draftSpecFromAttachments 1,311 → 1,296; draftBriefFromGrilling 1,695 → 1,685; chat 1,627 → 1,616; summarizeConversation 1,537 → 1,533; redraftSpecProposal 1,862 → 1,853; redraftBriefProposal 1,313 → 1,304; analyzeFeedback 2,144 → 2,112; proposePromptVersion 2,050 → 2,018; redraftPromptVersion 3,150 → 3,087; the other seven unchanged (grillingFollowUp 984, grillingQuestions 1,235, suggestFeatures 1,450, draftSpecFromSuggestion 1,254, checkFeatureFit 1,315, redraftChoices 1,840, redraftFeatureSuggestion 1,247).

1. **Deduplicate context — kept** (`src/retrieval/context-dedupe.ts`, applied in `ContextRetriever`'s fit). A chunk whose text an earlier block already holds is dropped (an archive or appendix copy of a section, a Spec's first chunk inside its excerpt in the Project's Feature overview); a start or end of a chunk that an earlier block repeats (the chunker's overlap between pieces of a long section, whichever piece ranked first) is cut, the heading kept, "…" marking the cut; what is left is dropped if it is under 80 characters or already shown. Texts under 80 characters are never treated as repeats. Feature Suggestions no longer get Decisions in their context that their Decision Log section already shows (`withoutShown`). Alone it lowers every Project-level task (up to -25%) and the Spec from Attachments (-10%); on budget-bound Feature tasks the room it frees is refilled with other, distinct chunks, so Choices went +0.3% on its own. It is kept together with top-k, under which every task goes down; no score is lower either way.
2. **Retrieval top-k — kept** (`RETRIEVAL_TOP_K` in `context-budget.ts`, on every `Budget` as `topK` and passed to each retrieval). Every search returned enough chunks to fill the ceiling (30 per search for a Decision Request, about 70 for a Project-level task) since 0060 doubled the ceilings, so the second half was chunks ranked far down. Now: Decision Request tasks, Feature Conversations and the fit check 15 (the pre-0060 size); Grilling, Feature Suggestions and Project Conversations 30; Spec from Attachments still fills its budget (the Attachments are its input). The Feature's own Spec, open requests and Decisions, or the Brief and the Feature overview, still come first and whole; the ceilings stay the limit. Chat keeps `searchContext` for more. The benchmark's retrieval scenario uses the Decision Request top-k; retrieval and the chat turn send no more statements (query budgets unchanged and passing).
3. **Trim prompts — kept.** Removed lines repeating the language rules partial ("Keep exact numbers, names and terms" in four prompts, "Keep names, ids and numbers as written" in the Conversation Summary), the Brief re-described in Choices and Spec Proposal, and the summary's sections re-listed in chat. The language partial and every injection defence (each data section's "untrusted data" line, chat's "Untrusted data" section, the feedback-is-data sections) are unchanged; `packages/skills` tests still check the partial once per prompt. Saves 4–63 tokens per prompt; small, since few instructions were truly repeated.
4. **Order for cache hits — kept.** The Attachment summary, the Grilling follow-up and the Conversation Summary now put their instructions and language rules first and their data after a `{{cacheBreak}}` (cacheable prefix 0 → 672, 843 and 1,024 tokens, all over the 512-token minimum); their placeholders are the same, so existing Prompt Versions still render. Chat names its Feature or Project after the Brief and Guidelines instead of in its first line, so the instructions-Brief-Guidelines prefix is the same in every Conversation of a Project and language. Tokens per call are not higher for any of them (the added cut lines were offset by trims); the gain is cache reads on a real Anthropic model, not measurable with the fake.
5. **Cheaper models for simple tasks — kept, as suggestions only.** `GET /settings/ai/model-suggestions` (Admin, `ModelSuggestionsView` in `@vorasaan/shared`, `prompt-versions/model-suggestions.ts`): for each Settings task not overridden by `VORASAAN_MODEL_*`, an Approved Model priced lower (on the task's token mix of the last 30 days, or 3:1 without calls) is suggested only when, on every prompt of the task that has checked-in cases or a replay, the latest done Eval Runs of the prompt's **active** version on both models, with the same sources, score it at least as high. A cheaper model with runs missing is listed with the prompts to evaluate. Settings → AI usage shows "Cheaper models": the scores per prompt, the 30 days' cost on each model, and "Use Fast for Summaries", which sets the task's model only when the Admin presses it (`PUT /settings/ai/tasks`). Nothing changes by itself. No token change.

### Not kept / not tried
- A smaller top-k than the pre-0060 sizes, and filler-free retrieval for Choices: not tried, because the fake can't show whether the Choices lose useful background without a real model and real embeddings.
- Shortening the language partial: not tried (the rules stay as 0068 set them).

### Tests
- `retrieval/context-dedupe.test.ts`: a repeated chunk (and an archive copy) is removed, a short text kept, the overlap cut whichever piece came first, a Spec chunk inside its overview excerpt removed, the Decision Log not repeated. `context-retriever.api.test.ts`: a long section and its archive copy in two Attachments are sent with every sentence exactly once.
- `ai/prompt-cache.test.ts`: the Attachment summary, Grilling follow-up and Conversation Summary keep a stable prefix first (instructions and language), the same for different data; chat's first part is the same for two Features of a Project.
- `evals/token-guard.test.ts`, `evals/token-scenarios.api.test.ts`: above. `prompt-versions/model-suggestions.api.test.ts` (real Postgres): suggested with scores and costs only when cheaper and holding, nothing switched until the Admin sets it, not suggested when one prompt scores lower or nothing is cheaper or unpriced, Admins only. e2e `settings-ai-usage.e2e.ts`: an Admin runs evals on two models, sees the suggestion, chooses it, and it is set.

### Verify with a real model (manual)
1. Scores with less context and the new prompts: on the commit before this ticket and on this one, with the same model (`ANTHROPIC_API_KEY` or the provider the env vars name), run from `apps/server`:
   ```bash
   for set in choices spec-from-attachments grilling feature-suggestions conversation redrafts prompt-proposals; do
     bun run eval:$set > /tmp/eval-$set-0076.log
   done
   grep '══' /tmp/eval-*-0076.log
   bun run eval:retrieval   # the needle, early, and the Choices keep 22:30 and 12 THB
   ```
   Compare the `══` totals per set (Thai included); a lower one means reverting the change it comes from.
2. In the app on a real model: run Eval Runs of `generate-choices` and `draft-spec-proposal` with the replay source before and after deploying, and compare the runs (Settings → AI prompts → Evals → compare).
3. Real tokens: Settings → AI usage over a week before and after; tokens per call by task should fall about as in the table above.
4. Cache reads for the reordered prompts: on an Anthropic model, add two Attachments within 5 minutes; the second `[AiUsage] summarize-attachment` log line shows `cache read` > 0. The same for two Grilling follow-ups in one round and two Conversations on different Features of one Project.

No new domain term: a suggested cheaper model is an Approved Model the Admin may set for a task.
