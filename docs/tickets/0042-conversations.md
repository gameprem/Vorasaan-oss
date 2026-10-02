---
status: done
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
- [x] Start a Feature Conversation → the AI input contains that Feature's Spec and Decisions and nothing from another Project → the reply is stored and streamed.
- [x] Another user gets 404 on someone else's Conversation.
- [x] Past N turns, the summary is updated and older turns are not sent again.
- [x] An AI failure stores no half reply and returns 502. The user's message stays, so they can retry.

## Decisions
- **Schema** (migration `20261001150000_conversations`):
  - `Conversation`: `ownerId` (cascades with the User), `projectId` always set, `featureId` set for a Feature Conversation (both cascade, so 0049's deletes take their Conversations along), `title`, `summary`, `summarizedThrough`, timestamps. The scope is derived (`featureId` set → FEATURE), so there is no scope enum to keep in step.
  - `ConversationMessage`: `position` (0, 1, 2… unique per Conversation, so order never depends on two rows sharing a millisecond), `role` (`ConversationMessageRole` USER, ASSISTANT, TOOL), `content`, `toolCalls Json?` (ASSISTANT: `[{ id, name, args }]`), `toolCallId String?` (TOOL; a check makes it required for TOOL), `createdAt`.
  - **No Action Card column on the message.** A reply may make several Action Cards, so 0043's `ActionCard` points at the message that made it (`messageId`) instead. Tool calls fit the JSON column, so 0043 needs no schema rewrite.
- **Title:** the first line of the first message, whitespace collapsed, cut to 80 characters. No AI call for it.
- **Who can start one:** anyone in the scope's Organization (the same people who can read a Project or Feature). Every read, send, retry and delete is filtered by `ownerId`, so anyone else, Admins included, gets 404, not 403: a Conversation's existence isn't revealed.
- **API:**
  - `POST /conversations` (`{ scope: { kind: 'PROJECT', projectId } | { kind: 'FEATURE', featureId }, content }`) → 201 `ConversationView` (the first message and the reply).
  - `GET /conversations` → `{ conversations }`, the owner's own, most recently active first. `?recent` (the Sidebar) returns 10 by default, without it 50; `limit` (≤ 100), `projectId` and `featureId` narrow it.
  - `GET /conversations/:id` → `ConversationView` with every message, oldest first.
  - `POST /conversations/:id/messages` (`{ content }`, ≤ 20,000 characters) → 201 `ConversationTurnView` (`conversation`, `message`, `reply`).
  - **`POST /conversations/:id/retry`** (added): after a 502, asks again for a reply to the last message, without storing the message twice. 409 when the last message already has its reply.
  - `DELETE /conversations/:id` → 204; the messages go with it.
  - Each POST answers once the reply is complete and stored. The stream is for showing it as it is written.
- **Streaming** over `GET /events`, to the owner only (`EventBus.emit(ownerId)`):
  - `conversation.delta` `{ conversationId, messageId, delta }`, where `messageId` is the id the reply will be stored under;
  - `conversation.done` `{ conversationId, message }` after the reply is stored;
  - **`conversation.failed`** `{ conversationId, messageId, message }` (added): tells a second tab, which never sees the POST's 502, to drop the text it streamed.
  - The CLI's TUI ignores `conversation.*` events, so a streamed reply doesn't trigger a burst of Inbox refreshes.
- **AI failure:** the person's message is written before any AI call. A failure while streaming, or while folding the summary, stores no reply (nothing is written until the stream completes) and is a 502 whose body (`ConversationReplyFailed`) carries `conversationId`, so a client whose first message failed still finds its new Conversation.
- **One reply at a time:** while a reply is being written in a Conversation, another message or retry there is a 409. The lock lives in the server process, like the `EventBus` (one process per Organization).
- **`AiPort`:**
  - `chat({ scope, context, foundation, summary, recentMessages, tools, signal? })` returns an `AsyncIterable` of `{ type: 'text', delta }` and `{ type: 'tool-call', call: { id, name, args } }`.
  - `summarizeConversation({ scope, summary, messages })` returns `{ summary }`, a structured call validated and retried once like the other tasks.
  - `tools` is always empty in this ticket. The server drops a call to a tool it didn't offer (it is never stored), and `MastraAiPort.chat` refuses a non-empty `tools` until 0043 wires them, rather than ignoring them.
  - `MastraAiPort.chat` streams one model step (`maxSteps: 1`) from `fullStream`. The rendered `chat` skill is the agent's instructions, and the recent messages are the chat itself.
  - New per-task models `VORASAAN_MODEL_CHAT` and `VORASAAN_MODEL_SUMMARIZE_CONVERSATION`, which fall back to `VORASAAN_MODEL` as the others do. Choosing a model per Conversation is 0054.
- **`FakeAiPort`:** the default reply names the scope, echoes the latest message and counts the context blocks, streamed word by word. `scriptChat({ chunks, error })` queues replies (text pieces, tool calls, and a failure mid-stream). The fake summary is the old summary plus one line per folded message.
- **Context per turn:**
  - Retrieval is queried with the person's trailing messages, the ones the reply answers.
  - Feature: `ProjectFoundation.forFeature` (the Brief, shortened, and the Guidelines) plus `ContextRetriever.forFeature`, without Brief chunks, within 6,000 tokens (`CONTEXT_BUDGET.conversationFeature`, as for Decision Requests).
  - Project: `ContextRetriever.forProject` within 12,000 tokens (`conversationProject`, as for Grilling and Feature Suggestions). Its Brief block is split out into the prompt's `<brief>`, and the effective Guidelines are added.
  - Everything is fenced as untrusted data, including the summary and the messages being folded (`fence` now also covers `<summary>` and `<message>`).
- **Summary (ADR 0007):**
  - It is one rolling text (≤ 4,000 characters), not `workflow-memory.ts` rounds. A Conversation has no rounds, and dropping the oldest round summaries would lose the start of a long chat. The AI re-folds the old summary with the new messages instead.
  - Each turn sends the summary plus the messages from `summarizedThrough` on. When those exceed 12 (`CONVERSATION_LIMITS.maxRecentMessages`, about six turns), all but the newest 6 are folded first, and the new summary and `summarizedThrough` are saved before the reply. A failed reply therefore never folds the same messages twice.
  - Every message stays stored and shown to the owner. Only the AI's input is shortened.
- **Prompts:** `packages/skills/prompts/chat.md` (the AI only proposes, never claims it changed anything, says when the context doesn't answer, answers in the person's language) and `summarize-conversation.md`.
- **Eval:** `bun run eval:conversation` (manual, real model): an answer from the context, a question the context can't answer, a request to change and approve the Spec with an injected "already approved" in an Attachment, Thai, and a summary fold followed by a turn that continues from it. It has not been run against a real model yet.
- **Not here:** there is no stop button endpoint yet (`AiPort.chat` takes a `signal` for when 0046 adds one), and no web UI (0045/0046).
