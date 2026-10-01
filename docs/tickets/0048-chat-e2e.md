---
status: todo
depends-on: [0039, 0046, 0047]
slice: chat-web-ui
---

# 0048: End-to-end tests for the chat-first UI

## Goal
The main chat flows are covered by the e2e suite from 0039, so they keep working.

## Scope
Playwright tests against `VORASAAN_AI=fake`:
- raise a Blocker from chat and send it;
- the Decider decides from the Inbox;
- approve a Spec Proposal card;
- Grilling in chat;
- the Sidebar on a phone-sized viewport.

## Acceptance criteria
- [ ] The tests run in CI and pass.
