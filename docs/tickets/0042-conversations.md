---
status: todo
depends-on: []
slice: chat-web-ui
---

# 0042: Conversations and streamed AI replies

## Goal
A person can chat with the AI about a Project or a Feature. The chat is stored, and the reply streams in as the AI writes it (ADR 0008).

## Scope
- Prisma:
  - `Conversation`: owner, scope (Project or Feature), title, a summary of earlier turns, timestamps.
  - `ConversationMessage`: role USER, ASSISTANT or TOOL, content, an optional Action Card reference, `createdAt`.
- `AiPort.chat(context, summary, recentMessages, tools)` streams text and tool calls. `FakeAiPort` replies deterministically and can be scripted to call a tool. Prompts live in `packages/skills`.
- Context:
  - `ContextRetriever.forFeature` or `forProject` on every turn, within the same token budgets as the other workflows.
  - Earlier turns are folded into the summary, not replayed (ADR 0007).
- API:
  - `POST /conversations` (scope, first message);
  - `GET /conversations?recent`;
  - `GET /conversations/:id`;
  - `POST /conversations/:id/messages`;
  - `DELETE /conversations/:id`.
  - The reply's text deltas are sent over `/events` as `conversation.delta` / `conversation.done`, and only to the owner.
- Only the owner reads a Conversation. Admins do not read other people's chats.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] Start a Feature Conversation → the AI input contains that Feature's Spec and Decisions and nothing from another Project → the reply is stored and streamed.
- [ ] Another user gets 404 on someone else's Conversation.
- [ ] Past N turns, the summary is updated and older turns are not sent again.
- [ ] An AI failure stores no half reply and returns 502. The user's message stays, so they can retry.
