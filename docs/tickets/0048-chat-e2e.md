---
status: done
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

## Coverage
Every scope item is proven end to end through the UI. Items already covered by 0045–0054 are referenced, not repeated.

| Scope item | Spec | Test |
| --- | --- | --- |
| Raise a Blocker from chat and send it | `chat-journey.e2e.ts` (new) | a Blocker raised in chat → sent → Claimed and decided from the Inbox → its Spec change approved → the Raiser sees the new Spec |
| The Decider decides from the Inbox | `chat-journey.e2e.ts` (new), for a Blocker raised in chat | same test |
| | `decision-request.e2e.ts` (0039), with Claim and NEEDS_INFO | raise → send to all POs → Claim → ask for info → answer → decide → approve the Spec Proposal |
| | `inbox-live.e2e.ts` (0039, 0045), the Inbox and its Sidebar count updating live | the Inbox updates live, without a reload |
| Approve a Spec Proposal card | `chat.e2e.ts` (0046) | an Action Card from a tool call: Approve, and the panel shows the new Spec Version |
| | `chat-journey.e2e.ts` (new), a Decision's Spec Proposal approved from the Inbox | a Blocker raised in chat → … → the Raiser sees the new Spec |
| Grilling in chat | `grilling.e2e.ts` (0047) | Grilling in chat → approve the Brief from its card → accept a Feature Suggestion → approve its Spec |
| The Sidebar on a phone-sized viewport | `shell.e2e.ts` (0045) | at 375px the Sidebar is a drawer and the page does not scroll sideways |

## Decisions
- **One continuous journey, in a new spec.** No spec went from chat to a decided Blocker: `chat.e2e.ts` only drafts Spec Proposals and Feature Suggestions, and `decision-request.e2e.ts` raises from the form. `chat-journey.e2e.ts` follows one Blocker: Beam (Backend) chats in the Feature's Conversation, the scripted AI (`POST /dev/fake-ai/chat-script`) calls `draftDecisionRequest`, the card shows the Choices and "goes to Pim and Mint; the first to Claim it decides", Beam presses Send. Mint, with her Inbox open, sees it arrive live and the Sidebar's Inbox count go up, opens it, Claims it and decides; she approves the resulting Spec Proposal from the Inbox's "Spec Proposals to approve". Beam's Conversation then shows the new Spec version in the panel and the header chip, and the decided line in the Spec.
- **The Raiser's open Conversation does not follow the approval live.** Approving a Decision's Spec Proposal sends the Raiser no event that refreshes the chat route, so the journey re-opens the Conversation before checking the panel. Making that live is product work, not this ticket's.
- **Fixed an order-dependent assertion in `decision-request.e2e.ts`.** The fake AI appends a `## Decisions` section to the Spec for every Decision, so once another test (now the journey) decides on the same Feature first, `getByRole('heading', { name: 'Decisions' })` matched two headings and failed strict mode, every run. The assertion now looks inside the Spec (`.spec`) at the last `Decisions` heading and still requires this Decision's line.
- **Stability:** the full suite (18 tests) passed 3 of 3 runs locally in a row (59 s, 65 s, 76 s wall time).

## Acceptance criteria
- [ ] The tests run in CI and pass.
