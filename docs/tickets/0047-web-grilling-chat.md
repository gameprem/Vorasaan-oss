---
status: todo
depends-on: [0044, 0046]
slice: chat-web-ui
---

# 0047: Web: Grilling in the chat view

## Goal
Grilling questions arrive as a Conversation the person answers in their own words, instead of a form.

## Scope
- An Inbox Item "Answer Grilling" opens that person's Grilling Conversation.
- The header shows the round (Business, UX or Technical) and its progress, for example "3 of 5 answered".
- Questions that someone else already answered are shown collapsed, with who answered them.
- When the Brief Proposal is drafted, the starter's Conversation shows it as an Action Card.

## Acceptance criteria
- [ ] Browser-verified with `VORASAAN_AI=fake`, using two users: a PO answers in chat and gets a follow-up. The Designer's round opens next. The starter approves the Brief Proposal from the card.
