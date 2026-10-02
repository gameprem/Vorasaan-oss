---
status: done
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
- [x] With an 8k-window model, a Feature turn's prompt (measured by the fake's counter) stays under the window. With a 200k model, the same turn retrieves more context.
- [x] A Conversation of a few very long Thai messages compacts before it overflows. The summary keeps an agreed point and an id from early in the chat.
- [x] A scripted "too long" error from the provider triggers one compaction and a successful retry. A second failure is a 502, and no half reply is stored.
- [x] Browser-verified: the marker shows and expands to the original messages.

## Decisions
- **Schema** (migration `20261002100000_context_windows`): `ApprovedModel.contextWindow Int` (tokens, prompt and reply together), required. Existing models are backfilled from the known-model table, else 32,000. The API contract (`@vorasaan/shared`): `contextWindow` is optional on `CreateApprovedModelInput` and `UpdateApprovedModelInput` (4,096 to 10,000,000, `CONTEXT_WINDOW_LIMITS`) and always on `ApprovedModelSettingsView`; `KNOWN_CONTEXT_WINDOWS` and `knownContextWindow()` live there too, so the Settings form prefills the same value the server would. `ConversationListItem` (so also `ConversationView` and the turn's `conversation`) gained `summarizedThrough`: how many of the oldest messages the AI reads only through the summary.
- **Windows.** Left out on create, the window is the known model's, else `VORASAAN_CONTEXT_WINDOW`, else **32,000**. Changing a model's id without giving a window re-prefills it. An env model (`VORASAAN_MODEL*`) uses `VORASAAN_CONTEXT_WINDOW` first (the operator configured it on purpose), then the known window, then 32,000. Known windows, by model id prefix: current Claude Opus, Sonnet, Fable and Mythos models (4.6 and later, and 5.x) 1,000,000; other Claude models 200,000; GPT-4.1 1,047,576; GPT-5 400,000; GPT-4o and GPT-4 Turbo 128,000; o1, o3 and o4 200,000; GPT-3.5 Turbo 16,385; GPT-4 8,192. Anything else (local and OpenAI-compatible models) gets the default, and the Admin sets it. The window is on `ModelChoice`, so every call knows its model's window.
- **Counting** is `AiPort.countTokens({ system, messages })`. `MastraAiPort` uses Anthropic's counting API (`messages.countTokens`, `@anthropic-ai/sdk`, the messages sent as one text) for an Anthropic model, by its provider key or, for an env `anthropic/…` model, `ANTHROPIC_API_KEY`. OpenAI and OpenAI-compatible models use the 0059 estimate, as does any failed count: counting never fails a turn. `FakeAiPort` counts with the estimate times `tokenScale` (1 by default; above 1 plays a denser tokenizer). A Conversation counts once per turn, only the history (its summary and messages), and only from the second turn; retrieval, the foundation and the per-message split still use the estimate, the split scaled by the counted/estimated ratio of that turn.
- **One budget config**, `BUDGET_CONFIG` in `apps/server/src/ai/context-budget.ts`; `planBudget(window, workflow, { system })` splits a window:

  | Share | Of the window | Floor | Ceiling |
  | --- | --- | --- | --- |
  | Foundation: system prompt, Brief and Guidelines | 15% | 300 for the Brief and Guidelines | 4,000 for the Brief and Guidelines |
  | Retrieved context | 40% (65% for a one-shot task, which has no history) | 1,000 | per workflow, below |
  | History (Conversations) | 25% | 1,000 | 32,000 |
  | Room for the reply (and a turn's tool rounds) | 20% | 1,000 | 16,000 |

  The fixed part (`system`: the prompt template's estimate, the offered tools' schemas, inputs sent whole such as the Spec a draft edits, the Brief and answers of a Brief draft, the Grilling memory, plus a 150-token `promptSlack` for names and wrappers) comes out of the foundation's share first, then out of the context's. Past the window, context gives way first (to its floor), then history, then the Brief, then context and history entirely. Context ceilings per workflow are twice the old fixed budgets: Decision Request tasks and Feature Conversations 12,000, Spec from Attachments 30,000, Grilling, Feature Suggestions and Project Conversations 24,000, the fit check 12,000; a `searchContext` tool call 5% of the window (500 to 6,000). Larger windows buy nothing past the ceilings: ADR 0012 rejected sending more because it costs more and is answered less accurately. So at 8k a Feature turn gets 2,628 tokens of context and 2,000 of history; at 32k 12,000 and 8,000; at 200k (and 1M) 12,000 and 32,000. Project-level tasks retrieve within context plus foundation, since their Brief is the first retrieved block. `ProjectFoundation.forFeature` now takes `{ foundation, context }`: the Brief is cut to what the Guidelines leave of the foundation's share (`FOUNDATION_BRIEF_TOKENS` is gone), and Guidelines longer than it come out of the context. The retrieval order (ADR 0007) is unchanged. Every workflow now chooses its model first (`ContextBudgets.forTask`), plans from its window and passes the same model to the AI call.
- **Auto-compaction replaces the 12-message rule** (`CONVERSATION_LIMITS` is gone). Past 70% of the history share, the newest whole turns that fit in 35% of it are kept word for word (the current turn always is), and the rest is folded into the **Conversation Summary** (a new CONTEXT.md term), cut to 25% of the share (at least 200 tokens). A turn starts at a person's message, so a tool call is never separated from its result. The summarizer returns fixed sections (`goal`, `agreed`, `openQuestions`, `pendingActionCards`, `preferences`, `keyFacts`), gets the Conversation's Action Cards with their state, and the server renders them as Markdown headings, stored in `Conversation.summary`. Older free-form summaries are read as "the summary so far" and replaced at the next fold. A message longer than the history share left after the summary (one long paste on a small model) is shortened for the AI only, longest first; the stored message stays whole.
- **The prompt** is `packages/skills/prompts/summarize-conversation.md` (rewritten for the sections; ids and numbers copied exactly; written in the person's language). Eval cases are in `bun run eval:conversation`: an English fold with a pending Action Card and an id, and a Thai fold with an agreed point not yet in the Spec, an id (PAY-142) and numbers (24 hours, 1.5M). They are run manually, not in tests.
- **Agreed but not recorded.** The summary says when an agreed point isn't in the Spec or the Brief yet, and the chat prompt now lets the AI offer an Action Card for such a point on a later turn, with the Spec retrieved fresh. Proposing a card *before* folding, as part of compaction, is left as a follow-up: it needs a tool round inside the fold, and the fold runs before the reply, so a card would appear with no message to hang on.
- **Compact and retry.** `MastraAiPort.chat` turns a provider's "too long" error (Anthropic "prompt is too long", OpenAI `context_length_exceeded` and "maximum context length", common OpenAI-compatible wordings, on the error or its causes) into `ContextTooLongError`. The Conversation then folds everything before the current turn without counting, and runs the same step once more. A second failure is the usual 502 with `conversation.failed`; text streamed before it is never stored. The compaction stays done, so a retry starts from the compacted history. Other tasks don't compact (they have no history) and report the error as before.
- **Ordering for prompt caching (0061).** Nothing new goes before the stable part of the prompt: the instructions, then the Brief and the Guidelines, come first as before; retrieved context, then the Conversation Summary, then the messages follow. Compaction only rewrites the summary and moves where the messages start, so it never touches the prefix 0061 will cache.
- **Web.** Settings → AI models shows each model's window ("200k tokens") and edits it; while adding a model, the field follows the model id until the Admin types a value. In a Conversation, the summarized messages are folded behind a quiet "Earlier messages were summarized" button (`aria-expanded`); opening it shows the originals with a "The AI reads the messages above as a summary" line after them. Browser-verified with `e2e/conversation-compaction.e2e.ts` (a small-window Approved Model and three long Thai messages).
- **Tests.** `context-budget.test.ts` (shares, floors, ceilings, fit at every window, the windows table and env), `token-count.test.ts` (Anthropic counting against a stand-in server, fallback, the fake's counter, "too long" detection), `context-budgets.api.test.ts` (the four criteria: an 8k Feature turn fits by the fake's counter while 200k retrieves more; long Thai messages compact and keep "ตกลง… PAY-142"; one compact-and-retry, then a 502 with nothing stored; one long message shortened for the AI only; the window in Settings), and the 0042 fold tests rewritten for compaction.
- **Left open.** The summarizer runs on the SUMMARIES model, whose window may be smaller than the chat model's; a very long fold on a small summarizer can still fail (a 502, the message stays). OpenAI has no counting call wired in (estimate only). Other scripts (Chinese, Japanese) are still estimated at four characters per token (0059).
