---
status: done
depends-on: [0042]
slice: chat-web-ui
---

# 0044: Grilling as per-person Conversations with follow-ups

## Goal
Each person answers Grilling questions in their own Conversation, and the AI asks follow-ups when an answer is thin. Multiple people can still answer at different times, and the result is still one Brief Proposal (ADR 0006, ADR 0008).

## Scope
- When a round starts, each holder of its Team Role gets a Grilling Conversation, and an Inbox Item points to it.
- The AI asks the round's questions one at a time. After each answer it may ask up to 2 follow-ups on that question, then moves on. The person can say "skip".
- An answer and its follow-ups are stored against the `GrillingQuestion`, with who gave them, so the Brief draft keeps attribution.
- The round ends when every question has an answer from someone who holds the role, as today. Other holders' threads are told so.
- The existing Grilling API keeps working, so the CLI and the form still answer.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [x] Two POs in one round: each gets their own Conversation. One answers question 1 with a follow-up. The other sees question 1 as answered.
- [x] A follow-up limit of 2 per question is enforced.
- [x] The Brief Proposal input contains the follow-up answers, attributed to the person who gave them.

Also tested (`apps/server/src/grilling/grilling-conversations.api.test.ts`): the answer that completes a round moves the Grilling on, the other holders are told and the next round's holders get theirs; answering through the old API marks the question answered in every Grilling Conversation (also mid-follow-up); "skip" and "ข้าม", and skipped questions coming back; someone who lost the Team Role gets 403 in their Conversation, through the API and when opening one; only the owner reads one (an Admin gets 404); `POST /grillings/:id/conversation` for a late joiner; a skipped round and a cancelled Grilling close the Conversations; an AI failure (the follow-up decision, or moving the round on) saves nothing and retry goes on; two holders answering the last question at once.

## Decisions
- **Schema** (migration `20261001180000_grilling_conversations`):
  - A Grilling Conversation is a `Conversation` with `grillingRoundId` set (cascades with the round, so with the Grilling and the Project). The Grilling is reached through the round, so there is no separate `grillingId` or kind to keep in step. A unique index on (`grillingRoundId`, `ownerId`) keeps one per person and round; a check keeps it a Project Conversation. 0042's privacy rule needs nothing new: every read and write is still filtered by `ownerId`.
  - `Conversation.grillingState` (JSON, set on every Grilling Conversation): the question being asked, the owner's answer and follow-ups so far, the questions they skipped there, and whether they were told the round is over. The exchange lives there until it ends, then it is recorded on the question in one go.
  - `GrillingQuestion.followUps` (JSON `[{ question, answer }]`): the follow-ups asked in the answerer's Conversation, next to `answer` and `answeredById`, so the attribution is the answerer's. A check keeps it on answered questions only.
- **One per person and round.** When a round starts (in the same transaction as the round), each holder of its Team Role in the Project's Teams gets one, titled "Grilling: Business round", whose first message introduces the round and asks the first unanswered question. Someone who joins later, or deleted theirs, opens one with **`POST /grillings/:id/conversation`** (holders only, 403; 409 once the Grilling isn't running; idempotent). The `ANSWER_GRILLING` Inbox Item gained `grilling.conversationId` (null when they have none yet).
- **The server asks, the AI follows up.** The questions, acknowledgements and notices are plain text the server writes (in English); only the follow-up questions come from the AI. That keeps the order, the "answered by someone else" notices and the limit deterministic. The AI writes the follow-up in the person's language.
- **Turns:** each message is answered as one ASSISTANT message. After an answer, `AiPort.grillingFollowUp` returns a follow-up or null. The server asks at most `MAX_GRILLING_FOLLOW_UPS` (2) per question: past it, it doesn't call the AI at all. When the exchange ends, the answer and the replied follow-ups go through `GrillingService.answer`, the same as the API, with the same row lock, revision check, no partial writes and the same 502 on an AI failure. Then the next unanswered question is asked.
- **Skip:** the whole message "skip", "pass", "ข้าม", "ข้ามไป", "ข้ามข้อนี้" or "ผ่าน" (`GRILLING_SKIP_WORDS`, case and a trailing "." or "!" ignored). Before an answer, it skips the question in that person's Conversation only; it stays open for the other holders and the round still needs it. During follow-ups, it records the answer as it is. Once the person has nothing left, they're told how many skipped questions still wait, and any message goes back to them. Skipping the whole round stays the starter's (`POST /grillings/:id/skip-round`).
- **Keeping Conversations in step:** after any answer, skip or cancel (through a Conversation or the API), `GrillingService` tells `GrillingConversationsService` which rounds changed. Each other Grilling Conversation of the round whose current question now has an answer gets a message saying who answered it and what they said ("…before you finished, so your reply to it wasn't recorded" if they were mid-way), then its next question. When the round ends, each gets one closing note. A Conversation busy with a reply is left alone; that reply reads the round as it is. One person answering a question through the API moves their own Conversation on without a notice.
- **Answered first:** two holders answering the same question at once: the first one recorded counts; the other's reply stays in their Conversation and they're told it wasn't recorded. Nothing is merged.
- **Permissions:** while the round is open, a message in a Grilling Conversation from someone who no longer holds its Team Role is a 403 and isn't stored. After the round ends, any message gets the closing note, without an AI call.
- **Locks:** the per-process reply lock moved into `ConversationLocks` (`ConversationLocksModule`), shared by `ConversationsService` and `GrillingConversationsService`, so a reply and a server-written notice never interleave in one Conversation.
- **Views and events:**
  - `ConversationListItem.grilling` (`{ id, round, role }` or null) marks a Grilling Conversation.
  - `ConversationView.grillingProgress`: the Grilling's and round's status, "answered of total", and each question as ANSWERED (with who), ASKING (with the follow-ups asked so far), OPEN or SKIPPED. 0047 builds its header from it.
  - `GrillingQuestionView.followUps` in every Grilling view.
  - A turn answers with the usual `ConversationTurnView` and `conversation.done`. Messages the server adds outside a turn are announced to the owner with the new **`conversation.appended`** `{ conversationId, messages }` (under `conversation.*`, so the CLI's TUI ignores it).
- **AI:**
  - `AiPort.grillingFollowUp({ project, round, role, question, answer, followUps, remaining })` → `{ followUp: string | null }`. It is part of the GRILLING task in Settings (env `VORASAAN_MODEL_GRILLING_FOLLOW_UP`). Prompt: `packages/skills/prompts/grilling-follow-up.md`. The question, the answer and the exchange are fenced (`fence` also covers `<question>` and `<exchange>`).
  - `GrillingAnswerForAi` gained `answeredBy` (`{ name, role }`) and `followUps`. The Brief draft prompt shows `by` and `role` on each answer with its follow-ups, and asks for disagreements to be written down with who said what. The round memory includes the follow-ups.
  - `FakeAiPort.grillingFollowUp` asks a follow-up when the latest reply has fewer than 4 words. `scriptGrillingFollowUps(...)` queues decisions (text, null, or an Error).
  - `bun run eval:grilling` gained follow-up cases (vague, specific, "not decided", a second follow-up, Thai, an injection in the answer) and attributed answers with follow-ups in the Brief drafts. It has not been run against a real model.
- **CLI:** only its Inbox fixture gained `conversationId`. It answers through the API as before.
- **Not here:** the web UI (0047). No Notification is sent when a Grilling Conversation is opened: the Inbox Item and `inbox.changed` already point to it.

