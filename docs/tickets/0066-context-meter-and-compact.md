---
status: todo
depends-on: [0054, 0060, 0061]
slice: context
---

# 0066: Context meter and /compact

## Goal
A person sees how full their Conversation is, and can compact it themselves with a say in what the Conversation Summary keeps (ADR 0012).

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
- **Reading the summary:** the "Earlier messages were summarized" marker gains "View summary", which shows the Conversation Summary's sections. Whether a person may edit it is decided here and recorded; if editable, the edit is written to the Conversation's history.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] The usage numbers of a turn match the server's budget plan for that model's window.
- [ ] Switching to a model with a smaller window returns usage for that window.
- [ ] `/compact keep the limits` folds the history, passes the focus to the summarizer, and stores it.
- [ ] Compacting with an agreed point that isn't in the Spec offers an Action Card first.
- [ ] Browser-verified: the meter updates live after each turn and warns near the threshold, `/compact` folds the chat, and "View summary" shows the summary.
