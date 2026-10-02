---
status: done
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
- [x] Unit tests: the Anthropic adapter marks the prefix and leaves volatile parts unmarked. Other adapters send the same text as before.
- [ ] Manually verified against a real Anthropic key: the second turn of a Conversation reports cache reads. (Left for the user: steps in Decisions.)

## Decisions
- **Order, every workflow.** The task's own instructions (its intro, "What to produce" and "Rules") now come first, then the Project Brief and the Guidelines, then the Feature's Spec, then retrieved context, then history, then the new input. Changes per prompt (`packages/skills/prompts/`):
  - **Choices, Spec Proposal:** instructions, Brief + Guidelines, Spec, context, the Decision Request (and the Decision). Before, the Spec came first and the instructions last.
  - **Spec from Attachments:** instructions, the Feature, its Spec, context (the Attachments).
  - **Grilling questions:** the round's focus and instructions, Guidelines, then the context with the Brief first, then the earlier rounds.
  - **Brief draft:** instructions, the current Brief, Guidelines, context, the rounds, the answers.
  - **Feature Suggestions, Spec from a Suggestion, fit check:** instructions, Guidelines, then the context with the Brief first, then the Decision Log, dismissed and pending suggestions / the accepted suggestion / the new Feature.
  - **Chat:** already right (system prompt, Brief, Guidelines, context, summary; the messages follow as the chat). Only a cut was added.
  - **Left as they were:** Grilling follow-up, Attachment summary and Conversation Summary have no Brief, Guidelines or Spec, and are below any cacheable length, so there is nothing stable to cache.

  Every reordered prompt says "These instructions come first; the material to work from follows them", and "above" became "below" where it pointed at the data. The text is otherwise word for word. The eval sets (`bun run eval:*`) were not run here (no key); run them before a release to confirm quality holds with the instructions first.
- **Cuts.** A template marks where a stable part ends with `{{cacheBreak}}`; the server also cuts inside the context after its lead block when that block is stable (the Feature's own Spec in a Feature Conversation, the Brief of a Project-level task). `renderPrompt` turns a skill into a `Prompt` (`apps/server/src/ai/prompt-cache.ts`): `{ text, parts }`, where `parts.join('') === text`. The break is a random per-process sentinel, so no document or message can forge one, and it never reaches a provider. Context indexes run on across a cut, so the text is exactly what it would be uncut.
- **Anthropic marks** go through Mastra's idiomatic route: the AI SDK provider option `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` (5-minute TTL), which the bundled `@ai-sdk/anthropic` turns into `cache_control`. A one-shot task sends one user message with one text part per cut, the stable parts marked; a chat sends its system prompt as system blocks, the stable ones marked; the history and the new message are never marked. A part is marked only when the prefix through it (with the short generic system prompt) is at least 512 tokens by the 0059 estimate, the smallest minimum of current Anthropic models; on a model with a higher minimum a shorter prefix just isn't cached (no error, no write cost). At most 4 marks (Anthropic's limit; the prompts have at most 2). So the cached prefixes are: tools, system, instructions + Brief + Guidelines; then + the Spec. A model counts as Anthropic when Mastra calls it through its Anthropic provider (`anthropic/…`, without a custom URL).
- **Other providers unchanged.** OpenAI, OpenAI-compatible and any other model get `prompt.text`: one user string for a task, one system string for a chat, as before. OpenAI's automatic prefix cache (1,024 tokens and up) now hits on the same ordered prefix.
- **Cost trade-off.** A marked prefix costs 1.25x to write once and 0.1x (or less) to read for 5 minutes. Chat turns and repeated Choices / Spec Proposals on one Feature reuse it; one-off tasks (a Grilling round, a Brief draft) pay the write premium on their prefix with little reuse. Accepted: it is small, and those calls are rare.
- **Cache usage is logged** for every call made through `MastraAiPort` (the `AiUsage` logger): `generate-choices: input 1840 (cache read 1500, cache write 300), output 12`, from the AI SDK usage (`cachedInputTokens`, `cacheCreationInputTokens`, else the raw input details). OpenAI reports cache reads only. There is no AI usage view and the Decision Lead Time view (0056) isn't built yet, so nothing is shown in the web: **follow-up**, store per-call usage and show it once a usage view exists.
- **Tests.** `prompt-cache.test.ts`: every workflow's prompt in stable-to-volatile order and cut where expected, the cut text identical to the uncut text, unforgeable breaks, the 512-token and 4-mark rules, usage parsing and the log line. `mastra-cache.test.ts`: `MastraAiPort` against a local stand-in of the Anthropic Messages API (Choices: instructions/Brief/Guidelines and Spec parts marked, the request part not; chat: system blocks marked up to the Spec, context, summary and messages not; the cache read/write logged) and against an OpenAI-compatible stand-in (the same text as one unmarked message, as before).
- **Manual check (not done here: no Anthropic key in this environment).** To verify:
  1. Set an Anthropic provider in Settings → AI models (or `VORASAAN_MODEL=anthropic/<model>` with `ANTHROPIC_API_KEY`), on a Project with a Brief of a few paragraphs and some Guidelines, and a Feature with a Spec.
  2. Open a Feature Conversation and send a message. The server log shows `[AiUsage] chat: input … (cache read 0, cache write N), output …` with N > 0 (the prefix was written).
  3. Within 5 minutes, send a second message. The log shows `cache read M` with M > 0, about the size of the instructions, Brief, Guidelines and Spec.
  4. Optional: raise two Decision Requests on the same Feature within 5 minutes; the second `generate-choices` line shows a cache read.
  If the prefix is shorter than the model's minimum (512 to 4,096 tokens), both reads stay 0: use a longer Brief or Spec.
