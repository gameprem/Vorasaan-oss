---
status: todo
depends-on: [0057]
slice: decision-speed
---

# 0058: Decide from LINE, Slack and Teams

## Goal
A Recipient answers a Decision Request without opening Vorasaan (ADR 0011).

## Scope
- **Cards:**
  - When a request is sent to a linked person, they get a card in their chat app: Flex Message on LINE, Block Kit on Slack, Adaptive Card on Teams.
  - The card shows the title, the kind (Blocker in seal red), the Choices with their impact, the due time, and buttons for each Choice, Ask for more info, and Open in Vorasaan.
- **Buttons:**
  - A button press is checked against the linked account, then calls the same `DecisionRequestService` method as the web app.
  - "Ask for more info" opens the provider's text input (a modal on Slack and Teams, a reply prompt on LINE).
  - "Write your own answer" is offered the same way when the request allows it.
- **When something changed:** if the request was decided, claimed by someone else, or withdrawn, the reply says so (for example "Already decided by Nok: Choice A") and the card is updated where the provider allows it.
- **Other cards:** NEEDS_INFO questions go to the Raiser, and escalation reminders from 0055 go to whoever they target. Spec Proposals only get a "Review in Vorasaan" link.
- **Language:** card text follows the person's language. The fixed UI strings exist in Thai and English.

## Acceptance criteria (test first, real Postgres, fake provider servers)
- [ ] Pressing Choice B on a Slack card decides the request as that person, and the Decision Log records the source as Slack.
- [ ] A press from an account linked to someone else, or with no link, is refused and changes nothing.
- [ ] Pressing a Choice on a card for a request that was already decided returns the "already decided" reply and doesn't change the request.
- [ ] Manually verified against a real LINE channel and a real Slack workspace, using test accounts.
