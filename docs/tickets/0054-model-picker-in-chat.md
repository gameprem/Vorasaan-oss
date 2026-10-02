---
status: done
depends-on: [0042, 0053, 0046]
slice: chat-web-ui
---

# 0054: The model picker in chat

## Goal
People choose the model per Conversation, the way they do in Claude or Gemini (ADR 0010).

## Scope
- **Server:**
  - `Conversation.modelId` is set from the message that was sent. A new Conversation uses the Organization default.
  - Every assistant `ConversationMessage` records the model that wrote it.
  - An Action Card's proposal (Spec Proposal, Brief Proposal, Decision Request draft) records the model that drafted it, so the Spec history and the Decision Log can show it.
  - If a Conversation's model was removed, the next message uses the default, and the reply says so once.
- **Web:**
  - The composer has a model menu showing the display name and note of each Approved Model, with the current one ticked.
  - The choice applies from the next message.
  - Each AI reply shows its model's display name in small text.
  - Keyboard: the menu opens from the composer and is navigable with the arrow keys.
- **Mockup:** `docs/design/chat-web-ui-mockup.html` shows the menu.

## Acceptance criteria
- [x] Test first, real Postgres + `FakeAiPort`: switching the model mid-Conversation sends the next turn to the new model, and earlier messages keep their recorded model.
- [x] A removed model falls back to the default with a notice. Nothing is silently switched in the middle of a reply.
- [x] Browser-verified with two fake Approved Models: picking "Fast" shows "Fast" under the next reply, and reloading keeps it.

Tests: `apps/server/src/conversations/model-picker.api.test.ts` (real Postgres + `FakeAiPort`: the default on a new Conversation, a pick when starting, switching mid-Conversation with earlier replies keeping their model through a rename, 422 for a model that isn't approved, a removed model's fallback and its one notice, a model removed while a reply with a tool round is being written, Spec and Brief Proposals and a Decision Request's AI Choices drafted from Action Cards and shown in the Spec history, Brief history and Decision Log, `VORASAAN_MODEL_CHAT`, retry), a 422 for a pick in a Grilling Conversation in `grilling-conversations.api.test.ts`, and `chatDefaultId` in `ai-settings.api.test.ts`. `apps/web/e2e/chat.e2e.ts`: two fake Approved Models; the menu with the mouse and the keyboard; "Fast" under the next reply and after a reload; the menu on a 390px phone; "Drafted with Fast" in the Spec history.

## Decisions
- **Schema** (migration `20261001190000_model_picker`):
  - `Conversation.modelId`: the Approved Model picked in it, a foreign key with `ON DELETE SET NULL`. Null means nobody picked one (or it was removed): the Conversation then runs on the chat default.
  - The model that wrote or drafted something is stored as a snapshot of three columns: `approvedModelId` (a plain id, no foreign key, so it outlives the model), `modelDisplayName` and `modelName` (the provider's model id, or the env "provider/model"). They are on `ConversationMessage` (ASSISTANT messages, including a step that called tools), `SpecProposal` and `BriefProposal`. `DecisionRequest` has the same three as `choicesApprovedModelId`, `choicesModelDisplayName`, `choicesModelName`, for its AI Choices.
  - `ConversationMessage.modelNotice`: the notice on the one reply after the Conversation's model was removed.
- **API**:
  - `POST /conversations` and `POST /conversations/:id/messages` take an optional `approvedModelId`. It must be one of the Organization's Approved Models, else 422 and nothing is stored. Sent with a message, it becomes the Conversation's `modelId` and stays for the messages after; leaving it out keeps the Conversation's model. `retry` uses the Conversation's model.
  - A Grilling Conversation's turns are written by the server, so it has no picker, and an `approvedModelId` there is a 422.
  - `ConversationListItem.modelId`; `ConversationMessageView.model` (`RecordedModel`: `approvedModelId`, `displayName`, `modelId`) and `modelNotice`.
  - `GET /ai/models` gained `chatDefaultId`: the Approved Model a Conversation with no pick runs on (Settings' model for chat, else the default), or null when there is none or `VORASAAN_MODEL_CHAT` overrides it. The web ticks it in the menu of a new Conversation.
  - `SpecVersionView.draftedWith` (from its proposal), `SpecProposalView.draftedWith`, `BriefVersionView.draftedWith`, `BriefProposalView.draftedWith` and `DecisionLogEntry.choicesDraftedWith`; null when not drafted in a Conversation.
- **A new Conversation uses the default, without storing it.** Its `modelId` stays null until someone picks a model, so it follows the chat default as Settings change it. Storing the default at creation would also turn it into a pick, which beats `VORASAAN_MODEL_CHAT` (below), so the env var would only ever apply to a first message.
- **One model per turn.** `ConversationsService` chooses the model once, before the turn's first step (`AiSettingsService.chooseModel('chat', modelId)`), passes it as `options.model` to every step, and records it on each ASSISTANT message. `ModelRoutingAiPort` now keeps an `options.model` the caller already chose. A model removed while a reply is being written doesn't change that reply, even across tool rounds; the next message falls back. The fold into the summary stays on its own task's model (SUMMARIES), before the reply starts.
- **A removed model.** Removing it sets `modelId` to null. On the next turn, when nobody picked another model, and the last recorded ASSISTANT message ran on an Approved Model that no longer exists, the reply carries "Fast was removed, so this reply used Best." The reply after it records the fallback, so the notice is given once. Picking a model in the same message needs no notice. The web shows the notice above the reply.
- **Action Cards use the turn's model.** `draftSpecProposal` and `draftBriefProposal` record it on the proposal. `draftDecisionRequest` drafts the AI Choices with it (passed to `generateChoices`) and records it on the request, so "Choices drafted with Fast" is true. `suggestFeatures` keeps its own task's model and records nothing, since the ticket doesn't ask to show it. A Decision Request raised from the form or the CLI records nothing.
- **`VORASAAN_MODEL_CHAT` and the picker.** 0053's precedence is unchanged: a picked Approved Model wins over the env var, which wins over Settings and the default. So the env var applies only to a Conversation with no pick. Every reply records what actually ran: an env model is recorded with no Approved Model and no display name, and the label under the reply shows its "provider/model". While the env var is set, `chatDefaultId` is null and the menu button of an unpicked Conversation reads "Server default" rather than ticking a model that wouldn't run.
- **Web:**
  - The composer's model menu sits between "+ Attachment" and the context line, as in the mockup: a menu button (`aria-haspopup="menu"`) and a `role="menu"` of `menuitemradio`s with the display name, the note (plus "default"), and a tick on the current one. Enter, Space, ArrowDown or ArrowUp open it on the current model; the arrow keys, Home and End move; Enter picks; Esc closes it and Tab leaves it, with focus back on the button. A click outside closes it.
  - The pick is held in the page and sent with the next message (start or send), so it applies from the next message. The current model is: the one just picked, else the Conversation's (while still approved), else `chatDefaultId`.
  - With a single Approved Model, only its name shows; with none, nothing.
  - Under 760px the menu is anchored to the composer (8px from its sides) instead of the button, so it never overflows; the button's name is cut with an ellipsis.
  - Each AI reply (not a tool step) shows the model's display name in small text under it.
  - "Drafted with Fast" under a Spec Version and a Brief Version in their histories, and "Choices drafted with Fast" on a Decision Log entry.
- **E2E**: the two Approved Models are created through the Settings API as an Admin in `chat.e2e.ts` (once per run), not in `reset-db.ts`: the server encrypts provider keys with its own `VORASAAN_SECRET_KEY`, which Playwright generates per run. The other specs pass with them in place. `E2E_SCREENSHOT_DIR` saves the ticket's screenshots.
