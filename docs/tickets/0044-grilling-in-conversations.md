---
status: todo
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
- [ ] Two POs in one round: each gets their own Conversation. One answers question 1 with a follow-up. The other sees question 1 as answered.
- [ ] A follow-up limit of 2 per question is enforced.
- [ ] The Brief Proposal input contains the follow-up answers, attributed to the person who gave them.
