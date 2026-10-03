---
status: todo
depends-on: [0043, 0058, 0060]
slice: proposals
---

# 0065: Request changes: the AI redrafts from a person's explanation

## Goal
A person who doesn't want a proposal as it is tells the AI what to change, and gets a Redraft of the same proposal to approve (ADR 0013).

## Scope
- **Where:** every AI proposal gets "Request changes" next to Approve and Decline:
  - the Choices of a Decision Request (the Raiser reviews them before sending);
  - a Spec Proposal;
  - a Brief Proposal;
  - a Feature Suggestion;
  - later, Design Docs (0069).

  It is offered in the Inbox, on the proposal's page, and on its Action Card in a Conversation.
- **Feedback:** free text, required, with an optional pointer to part of the proposal: one Choice, or a line or section of a Markdown proposal.
- **Redraft:** the AI redrafts the same proposal from the proposal, the feedback, the earlier feedback on it and the usual context. The result is Redraft 2, 3 and so on (the first proposal counts as 1).
  - Every Redraft is stored with the feedback that caused it, who gave it and when, and the model that wrote it (0054).
  - The proposal's page shows the Redrafts, the feedback on each, and a diff between any two, the way Spec Versions are compared (0020).
  - The latest Redraft is the one shown and the one Approve applies. Nothing changes before Approve.
- **Who:** the same people who may approve or decline the proposal. Anyone else gets a 403.
- **When not:** a proposal that is approved, declined or stale can't be redrafted (409). While a Redraft is being written, Approve and another Request changes wait for it.
- **A limit:** at most 10 Redrafts per proposal (configurable). After that, only Approve, Decline or a manual edit.
- **Preferences:** a preference stated in feedback (language, length, style) is written to the Conversation Summary's preferences (0060) when the proposal came from a Conversation, so later proposals follow it.
- **Kept for evals:** feedback stays stored with the proposal and can be exported as eval cases.
- **Chat Cards (0058):** a decision card and a Spec Proposal card get a "Request changes" button that opens a text input, as Ask for more info does. The reply links to the Redraft in Vorasaan.
- **Prompts:** a redraft prompt per kind of proposal in `packages/skills`, with eval cases including Thai.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] Request changes on a Spec Proposal produces Redraft 2. The feedback is stored, and the diff from Redraft 1 is returned.
- [ ] Pointing at one Choice redrafts the Choices with the pointer in the AI's input.
- [ ] Approving after a Redraft applies only the approved Redraft to the Spec; the earlier Redrafts change nothing.
- [ ] An approved, declined or stale proposal can't be redrafted (409). Request changes past the limit is refused.
- [ ] Someone who can't approve the proposal gets a 403, and nothing is stored.
- [ ] A preference in feedback ("answer in Thai, shorter") appears in the Conversation Summary's preferences.
- [ ] Request changes from a Slack card produces a Redraft as the linked person; a press from another account changes nothing.
- [ ] Browser-verified: Request changes on an Action Card, see Redraft 2 and its diff, approve it.
