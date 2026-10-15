---
status: done
depends-on: [0053, 0060, 0064, 0070, 0075, 0080]
slice: ai-providers
---

# 0081: Reasoning Level per task and per chat message

## Goal
Thinking tokens are billed as output and can cost many times the answer itself (on Gemini 3.8 Flash a `{"ok":true}` answer cost 5 output tokens plus 85 thinking tokens). An Admin sets how much the model may think, per AI task. A member asks for deeper thinking on one chat message when the question needs it. Vorasaan maps that one setting to each provider's own control and shows the reasoning tokens of every call.

## Scope
- **One setting, mapped per provider.** A Reasoning Level is `LOW`, `MEDIUM` or `HIGH`, mapped by the server:
  - Gemini: `thinkingLevel` (`low` / `medium` / `high`). Models that refuse it get `thinkingBudget` or nothing (0080's fix branch set the default to low).
  - Anthropic: `effort` (`low` / `medium` / `high`). Opus 5.5 always thinks, so `effort` is the only lever. Never send `thinking: {type: "disabled"}` to models that refuse it with a 400.
  - OpenAI reasoning models: `reasoningEffort`. Non-reasoning models get nothing.
  - OpenRouter: `reasoning: { effort }`.
  - OpenAI-compatible: nothing by default (servers differ). The setting is shown as "not supported by this provider".
  - A model known to refuse the parameter (e.g. Gemma) never gets it. A 400 caused by the parameter is retried once without it and logged.
- **Per task (Settings → AI models).**
  - The default is `LOW` for structured tasks: Decision Request choices, conversation summaries, redrafts, suggestions and grilling.
  - The default is `MEDIUM` for chat, Spec from Attachments and Design Docs.
  - The Admin can change each one. `VORASAAN_REASONING_<TASK>` overrides it for env models and evals.
- **Per chat message.** A "Think deeper" toggle beside the chat input:
  - It is off by default and applies to that one message only; it resets after sending.
  - It raises that message to `HIGH`.
  - It is disabled, with the reason, when the chat's model has no reasoning control.
  - Precedence: the message's choice, then the task's setting, then the default.
- **Reasoning tokens everywhere.** Logs, Receipts (0070) and the AI usage dashboard (0075) show reasoning tokens for every provider that reports them. A chat message sent with "Think deeper" shows its reasoning tokens.
- Add **Reasoning Level** to `CONTEXT.md`.

## Acceptance criteria (test first, real Postgres, fake provider APIs)
- [x] Each provider kind receives its own parameter for each level, and a model that refuses it receives none.
- [x] A 400 caused by the parameter is retried once without it.
- [x] Task defaults apply. An Admin's per-task change applies on the next call. The env override wins for env models.
- [x] A chat message with "Think deeper" is sent at `HIGH`; the next message goes back to the task's level.
- [x] The toggle is disabled with the reason for a model with no control. It is keyboard reachable and axe-clean in light and dark.
- [x] Reasoning tokens from Gemini, Anthropic, OpenAI and OpenRouter usage reach the log, the Receipt and the dashboard.

## Notes
- **Manual check against real APIs.** This needs keys for each provider; only Gemini was checked during 0080's follow-up.

## Decisions
- **Contract** (`@vorasaan/shared`): `ReasoningLevel` (`LOW | MEDIUM | HIGH`) and `ReasoningSupport` (`{ supported, reason }`). `ApprovedModelSettingsView.reasoning` and `AiModelView.reasoning` say whether a model's level can be set and why not ("Not supported by this provider", "This model has no reasoning control", "Turned off on the server (…)"); `AiModelsView.chatDefaultReasoning` says the same for the model a Conversation with no pick runs on (an env model included). `AiTaskModelView` gained `reasoningLevel` (null: the default) and `reasoningEnvOverrides`. `REASONING_DEFAULTS` gives each Settings task's default with a note for its calls that differ. `StartConversationInput` and `SendConversationMessageInput` gained an optional `reasoningLevel`; `ConversationMessageView` gained `reasoningLevel` and `reasoningTokens`; the Receipts export gained `reasoningLevel` (additive, still `vorasaan.receipt/1`, `docs/receipts-export.md`).
- **Schema** (migration `20261015120000_reasoning_level`): a `ReasoningLevel` enum; `AiTaskReasoning` (one row per Organization and Settings task, no row: the default); `ConversationMessage.reasoningLevel` (on the person's message and its reply) and `reasoningTokens` (on the reply, summed over the turn's steps); `Receipt.reasoningLevel` (a nullable string, like the Receipt's other kinds).
- **Mapping** (`apps/server/src/ai/reasoning.ts`, pure functions with unit tests; each option checked in the AI SDK providers bundled in `@mastra/core` 1.72.0):

  | Provider | Option sent (Mastra `providerOptions`) | On the wire | LOW / MEDIUM / HIGH | Gets nothing |
  | --- | --- | --- | --- | --- |
  | Gemini (`@ai-sdk/google` 3.0.101) | `google.thinkingConfig` | `generationConfig.thinkingConfig` | Gemini 3+ and `-latest`: `thinkingLevel` `low` / `medium` / `high`. 2.5: `thinkingBudget` 0 (Pro 128) / 2048 / nothing (its own dynamic thinking) | Gemma, `gemini-1.*`, `gemini-2.0-*` |
  | Anthropic (bundled `@ai-sdk/anthropic`) | `anthropic.effort` | `output_config.effort` | `low` / `medium` / `high` | models without effort: before Opus 4.5 and Sonnet 4.6 (`claude-sonnet-4-5`, `claude-haiku-4-5`, Claude 3) |
  | OpenAI (`@ai-sdk/openai` 3.0.88, Responses API) | `openai.reasoningEffort` | `reasoning.effort` | `low` / `medium` / `high` | non-reasoning models (the SDK's own rule: not o-series, not GPT-5+, or a `gpt-5-chat` model) |
  | OpenRouter (`@openrouter/ai-sdk-provider` 2.10.0) | `openrouter.reasoning` | body `reasoning: { effort }` | `low` / `medium` / `high` | `…/gemma-*` |
  | OpenAI-compatible | nothing | nothing | – | always ("Not supported by this provider") |

  Anthropic never gets `thinking` (no `disabled`, no `budget_tokens`): models that always think refuse `disabled`, and effort already bounds thinking. An env model is mapped by its Mastra prefix (`anthropic/`, `openai/`, `openrouter/`, `google/`); any other prefix gets nothing.
- **A refused parameter** (`isReasoningRefusal`): an `APICallError` with status 400 anywhere in the cause chain whose message or body names thinking, reasoning, effort, a budget or `output_config`. A structured call and a chat step that hasn't streamed anything yet are sent once more without the parameter, and `[AiReasoning]` logs a warning with the option and the provider's message. Any other 400 (a too-long prompt among them, which compaction handles) is not retried here. The Receipt records `null` in that case (changed 2026-10-15, see the follow-ups below).
- **Defaults** (`defaultReasoningLevel`): LOW for every structured task and every Redraft (Choices, Spec Proposals after a Decision or from a Feature Suggestion, acceptance criteria, summaries, Grilling, Feature Suggestions, the fit check, Prompt proposals); MEDIUM for chat, `draftSpecFromAttachments` and `draftDesignDoc`. The Settings tasks group several calls, so the default is per call and the Admin's setting per Settings task: Spec Proposals show "Default (Low)", with "Medium for a Spec drafted from Attachments"; Design Docs "Default (Medium)", with "Low for Redrafts". The connection test runs at LOW.
- **Precedence** (`chooseReasoning`, chosen on every call in `ModelRoutingAiPort` through `AiSettingsService.chooseReasoning`, so an Admin's change applies to the next call): the message's level ("Think deeper"), then the env, then the Admin's setting, then the default. The env wins over Settings for every model, as `VORASAAN_MODEL_<TASK>` does, and Settings names the variables that are set. `MastraAiPort` without a chosen level (the eval scripts) uses the same function with no setting, so the env override applies to evals.
- **Env, and `VORASAAN_GEMINI_THINKING`:** `VORASAAN_REASONING_<TASK>` (the suffix of `VORASAAN_MODEL_<TASK>`, e.g. `VORASAAN_REASONING_GENERATE_CHOICES`), then `VORASAAN_REASONING`, each `low`, `medium`, `high` or `off` (also `default`). 0080's variable is kept, not removed: it still applies to Gemini models only, after the two new ones, with its meanings (`low`, `high`, and `default` = off), and it is read by the connection test too. `off` sends no parameter at all, even for a "Think deeper" message, and the toggle then says "Turned off on the server (…)". One behavior changes on Gemini by design: with nothing set, chat and the drafts listed above now run at MEDIUM instead of 0080's server-wide low. `.env.example` documents all three.
- **Settings → AI models** gains "Reasoning Level per task", with a kit `Select` per task ("Default (Low)" / Low / Medium / High, the default's note as its description), "Save Reasoning Levels" (`PUT /settings/ai/reasoning`, Admin only; 403 for a member, 400 for an unknown level or task; `null` goes back to the default and a task left out is kept), the env variables that win, and the Approved Models with no control named. An Approved Model's row says "Reasoning Level: not supported by this provider" when it has none.
- **"Think deeper"** is a toggle chip in the composer row (after the model menu and the context meter; on a phone, 480px and under, its bulb alone, still named "Think deeper"), `aria-pressed`, off by default, and only on a Conversation that isn't a Grilling one. Sending turns it off again; the message carries `reasoningLevel: 'HIGH'`, stored on the person's message, so a retry after a failed reply keeps it. On a model with no control it stays focusable with `aria-disabled` and its description says why, and a press does nothing. A reply asked for at HIGH shows "Thought deeper · N reasoning tokens" (the provider's count summed over the turn's steps), stored on the reply.
- **Reasoning tokens.** `cacheUsageOf` already read the AI SDK's `reasoningTokens` / `outputTokenDetails.reasoningTokens` / v3 `outputTokens.reasoning`. Tested against stand-ins, every provider's count reaches the `[AiUsage]` line and `CallUsage`: Anthropic's `output_tokens_details.thinking_tokens`, OpenAI's `output_tokens_details.reasoning_tokens`, OpenRouter's `completion_tokens_details.reasoning_tokens` and Gemini's `thoughtsTokenCount`. From there the Receipt and the AI usage dashboard (0080's columns) take them unchanged.
- **Receipt.** `reasoningLevel` is the level sent: null when the model has no control or the operator turned it off.
- **Tests.**
  - `reasoning.test.ts`: every mapping, support, defaults, env precedence, `chooseReasoning`, refusal detection and the connection test's level.
  - `reasoning-providers.test.ts`: `MastraAiPort` against stand-ins for each provider, `src/test/fake-anthropic.ts` and `fake-openai.ts` (new), and `fake-gemini.ts` and `fake-openrouter.ts` (extended with a `refuse` hook). It checks each kind's parameter at each level on a task and a chat, none for refusing models, Gemini 2.5 budgets, nothing for an OpenAI-compatible endpoint, the defaults and env without a chosen level, 0080's variable, the retry once on a refusal (logged), no retry on another 400, and the reasoning tokens in the log and the usage.
  - `reasoning-settings.api.test.ts` (real Postgres): defaults, an Admin's change on the next call and back to the default, admin only and validation, the env override for an env model and in Settings, model support views and `off`, the Receipt's level, "Think deeper" at HIGH with its tokens and the next message back at the task's level, and a retry that keeps HIGH.
  - `e2e/reasoning-level.e2e.ts`, in light and dark: the setting, the toggle by keyboard with its tokens shown and off afterwards, the disabled reason, and axe on the composer and the thinking line.
  - The 0080 tests were updated: chat on Gemini is now `medium` by default.
- **Follow-ups (2026-10-15, `fix/0081-follow-ups`).**
  - **The Receipt records what was really sent.** When the provider refuses the reasoning parameter and the call (or a chat step) goes once more without it, `MastraAiPort` tells `AiCallOptions.onReasoningRefused` after the `[AiReasoning]` warning, which stays. `ReceiptingAiPort` then records `reasoningLevel: null` on the call's Receipt (`ReceiptEntry.reasoningRefused`); its `reasoningTokens` are the usage of the call that ran. A Conversation's reply records `reasoningLevel: null` too when any step of its turn was refused, so it doesn't say "Thought deeper"; the person's message keeps the level asked for, so a retry still asks for it. `docs/receipts-export.md` says so.
  - **OpenRouter models without reasoning.** OpenRouter's model list (`GET /models`, already read for the picker and the window, 0064) gives each model's `supported_parameters`. When an Approved Model on OpenRouter is added, or its model id or provider changes, the server reads the list once for both the window and the new `ApprovedModel.supportsReasoning` (migration `20261016120000_approved_model_supports_reasoning`): true when the parameters name `reasoning` or `include_reasoning`, false when they name neither, null when unknown (not listed, no `supported_parameters`, the list couldn't be read, or any other provider). The Admin's picker sends nothing new: the server reads the list itself, so the stored flag doesn't trust the browser and no web change was needed. `ResolvedProvider` and `ReasoningTarget` carry the flag; false is treated like a model with no control: no reasoning parameter on any call (the connection test included), `reasoning: { supported: false, reason: "This model has no reasoning control" }` in Settings and on `GET /ai/models`, so "Think deeper" is disabled with that reason, and the Receipt records `null`. Null keeps sending the effort, as before. `MastraAiPort` takes the flag from the call's chosen model only when the call runs on that very model (`reasoningTargetOfCall`); an eval script's own model is mapped by its id as before. Approved Models added before this change stay unknown until their model id is changed.
  - **Tests.** `settings/reasoning-openrouter.api.test.ts` runs the whole app on `MastraAiPort` against the fake OpenRouter (real Postgres): a task and a chat whose first attempt is refused (the `refuse` hook) end with a Receipt `reasoningLevel` of null, the fake's `reasoningTokens` and the log line, and the reply with no level while the message keeps HIGH; models listed with and without `reasoning`, unlisted or unsaid get the right flag, view and parameter, and changing the model id reads the list again. `openrouter.test.ts` checks `openRouterModelInfo`; `reasoning.test.ts` the flag in the mapping, the support and `reasoningTargetOfCall`. The fake OpenRouter's models take `supported_parameters`.
- **Left open.**
  - Manual check against real APIs (the ticket's Notes); only stand-ins were used here.
  - Whether `medium` is accepted by every Gemini 3 Pro model: a refusal falls back to the model's default through the retry.
  - The Anthropic list of effort models is by name and needs updating when a new family arrives; the retry covers a mistake.
  - OpenRouter Approved Models added before the follow-up have `supportsReasoning` null (the effort is still sent) until their model id is changed; nothing backfills them from the list.
  - The page-wide axe check of the chat page fails on the existing disclaimer's contrast (`--fg-faint`), which is outside this ticket.
