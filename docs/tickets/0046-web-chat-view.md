---
status: todo
depends-on: [0043, 0045]
slice: chat-web-ui
---

# 0046: Web: the chat view with Action Cards and a document panel

## Goal
A Conversation reads like Claude or Gemini: streamed replies, inline Action Cards, and the Spec or Brief open beside the chat.

## Scope
- Message list:
  - Markdown rendering.
  - Streamed text from `conversation.delta`.
  - A stop button.
  - Retry after an error.
- Composer: multi-line input, with Enter to send and Shift+Enter for a new line. Attaching a file or URL creates an Attachment through the existing API.
- Action Cards:
  - Decision Request draft: shows the Choices and Decider, with Edit and Send.
  - Spec Proposal or Brief Proposal: shows a diff, with Approve and Reject.
  - Feature Suggestion: Accept, or Dismiss with a reason.
  - Every card shows its state: PROPOSED, APPROVED, DECLINED or STALE.
- Document panel: the latest Spec or Brief opens on the right and can be closed. A pending proposal is shown as a diff there.
- New Conversation:
  - A greeting ("สวัสดี Pim", in the user's language) with starter cards. The cards come from the user's real pending work: an Inbox Item, a Grilling round waiting for them, a Feature without a Spec.
  - Inside a scope, the starters are chips, such as "Raise a Blocker", "Draft the Spec from the Attachments" and "Suggest Features".
- Under the composer: "The AI only proposes. Nothing changes until a person approves it."
- Visual design per ADR 0008 and `docs/design/chat-web-ui-mockup.html`:
  - AI replies have no bubble and are marked by the spark.
  - The user's messages are in a tinted bubble.
  - Action Cards use a soft shadow instead of a border.
  - The Spec panel is a rounded sheet.

## Acceptance criteria
- [ ] Browser-verified with `VORASAAN_AI=fake`: ask for a Spec change → a card with a diff appears → Approve → the panel shows the new Spec Version.
- [ ] The chat view matches the mockup in light and dark themes, checked with screenshots side by side.
- [ ] Cards and replies keep working with the keyboard alone, and screen readers announce streamed text politely.
