---
status: todo
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
- [ ] Test first, real Postgres + `FakeAiPort`: switching the model mid-Conversation sends the next turn to the new model, and earlier messages keep their recorded model.
- [ ] A removed model falls back to the default with a notice. Nothing is silently switched in the middle of a reply.
- [ ] Browser-verified with two fake Approved Models: picking "Fast" shows "Fast" under the next reply, and reloading keeps it.
