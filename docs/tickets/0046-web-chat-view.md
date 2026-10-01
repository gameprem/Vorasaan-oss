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
- An empty state with suggested prompts for the scope, such as "Raise a Blocker", "Draft the Spec from the Attachments" or "Suggest Features".

## Acceptance criteria
- [ ] Browser-verified with `VORASAAN_AI=fake`: ask for a Spec change → a card with a diff appears → Approve → the panel shows the new Spec Version.
- [ ] Cards and replies keep working with the keyboard alone, and screen readers announce streamed text politely.
