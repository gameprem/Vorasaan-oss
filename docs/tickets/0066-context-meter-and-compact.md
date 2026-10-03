---
status: todo
depends-on: [0054, 0060, 0061, 0077]
slice: context
---

# 0066: Context meter, /compact, chat history and cursor pagination

## Goal
A person sees how full their Conversation is, and can compact it themselves with a say in what the Conversation Summary keeps (ADR 0012). The whole chat history stays readable, and long Conversations open fast and load older messages as you scroll up, like a chat app.

## Scope
- **Usage from the server:** the server already plans and counts each turn (0060). It now sends the numbers:
  - a `conversation.usage` event on the event stream after each turn, and the same object in the turn's response;
  - the shares of the plan (foundation and system prompt, retrieved context, history, room for the reply), the model's Context Window, the history used against its share, the compaction threshold, and the last turn's cache reads (0061);
  - a Zod contract in `@vorasaan/shared`.
- **Meter:** a small meter under the composer, next to the model picker.
  - It shows how full the history share is, and turns a warning colour near the compaction threshold.
  - Hover or tap shows the shares, the Context Window and the last turn's cache reads.
  - Switching model in the picker recomputes it for that model's window.
  - Light and dark tokens (ADR 0008), and an `aria-label` that reads the numbers.
- **Manual compaction:**
  - A "Compact now" action in the meter's popover, and a `/compact [focus]` command in the composer.
  - The focus text steers the summary (for example "keep the payment limits"), and is stored with the compaction.
  - Before folding, if something agreed in the chat isn't recorded in the Spec or the Brief yet, the AI offers an Action Card to record it. Compaction goes on once the person acts on it or skips it. This closes what 0060 left open.
- **Chat history shown normally:** older messages are no longer folded behind a button or dimmed; this replaces the 0060 "Earlier messages were summarized" fold. Where a compaction happened, a thin divider reads "↑ The AI reads the messages above as a summary · View summary". A Conversation compacted several times shows one divider per compaction.
- **Reading the summary:** "View summary" on a divider shows the Conversation Summary's sections as of that compaction. Whether a person may edit it is decided here and recorded; if editable, the edit is written to the Conversation's history.
- **Cursor pagination**, like a chat app:
  - Opening a Conversation loads the latest ~50 messages, scrolled to the bottom.
  - Scrolling near the top loads older pages from `GET /conversations/:id/messages?before=<cursor>&limit=50`. The cursor is stable on `(createdAt, id)`, so messages with the same timestamp are never skipped or repeated.
  - The scroll position is kept when a page loads; the view doesn't jump. A skeleton shows while loading (0077).
  - When new messages arrive over SSE while the person is scrolled up, a "↓ New messages" pill appears; it scrolls to the bottom.
  - A deep link to a message loads the page around it, and pages load both ways from there (`after=<cursor>` too).
  - Pagination is independent of compaction and token budgets: it only decides what the screen loads, never what the AI reads.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] The usage numbers of a turn match the server's budget plan for that model's window.
- [ ] Switching to a model with a smaller window returns usage for that window.
- [ ] `/compact keep the limits` folds the history, passes the focus to the summarizer, and stores it.
- [ ] Compacting with an agreed point that isn't in the Spec offers an Action Card first.
- [ ] API: pages come newest first by `(createdAt, id)`; the first and last pages have the right edges (no cursor past the end, no duplicates); messages with the same `createdAt` are neither skipped nor repeated.
- [ ] API: messages that arrive while a person pages back don't shift or repeat the older pages; a deep-link page around a message pages both ways.
- [ ] Someone who can't read the Conversation gets a 404 on its messages.
- [ ] Browser-verified: the meter updates live after each turn and warns near the threshold, `/compact` compacts the chat, and "View summary" shows the summary.
- [ ] e2e with a 300-message Conversation: it opens at the bottom with the latest page; scrolling up loads more without the view jumping; a divider shows after compaction; messages above it are still readable, not folded or dimmed; a message arriving while scrolled up shows the "↓ New messages" pill.
