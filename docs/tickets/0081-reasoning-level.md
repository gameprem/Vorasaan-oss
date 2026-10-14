---
status: todo
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
- [ ] Each provider kind receives its own parameter for each level, and a model that refuses it receives none.
- [ ] A 400 caused by the parameter is retried once without it.
- [ ] Task defaults apply. An Admin's per-task change applies on the next call. The env override wins for env models.
- [ ] A chat message with "Think deeper" is sent at `HIGH`; the next message goes back to the task's level.
- [ ] The toggle is disabled with the reason for a model with no control. It is keyboard reachable and axe-clean in light and dark.
- [ ] Reasoning tokens from Gemini, Anthropic, OpenAI and OpenRouter usage reach the log, the Receipt and the dashboard.

## Notes
- **Manual check against real APIs.** This needs keys for each provider; only Gemini was checked during 0080's follow-up.
