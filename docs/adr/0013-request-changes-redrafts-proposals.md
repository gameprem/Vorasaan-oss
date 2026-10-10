# Request changes: the AI redrafts a proposal, not only approve or decline

Every AI proposal today has two answers: Approve or Decline. Choices that are almost right, a Spec Proposal with one wrong section, or a Brief Proposal in the wrong tone can only be declined and asked for again from scratch, or approved and then fixed by hand. People end up editing the AI's work themselves, and the AI never learns what was wrong.

We add a third answer, **Request changes**, to every AI proposal: the Choices of a Decision Request, a Spec Proposal, a Brief Proposal, a Feature Suggestion, and later Design Docs (ADR 0014).

- **The person says what to change.** They write it in their own words, and may point at part of the proposal: one Choice, a line or a section.
- **The AI redrafts the same proposal.** The result is a **Redraft**, numbered 2, 3 and so on (the first proposal is 1). It is still the same proposal, in the same Inbox Item or Action Card, not a new one.
- **Nothing is lost.** Every Redraft is kept, with the feedback that caused it and a diff from the one before.
- **Nothing changes until Approve.** Only the people who could approve the proposal can request changes or approve a Redraft, and approving applies only the Redraft that was approved. "AI proposes, human approves" (ADR 0001, ADR 0008) is unchanged; Request changes is one more way to say no.
- **Preferences carry over.** A preference stated in feedback (language, length, style) goes into the Conversation Summary (ADR 0012), so nobody has to repeat it.
- **Feedback is kept** with the proposal, so it can become eval cases for the prompts.
- **From chat apps too.** A Chat Card gets a Request changes button that opens a text input, like Ask for more info (ADR 0011).
- **A limit.** A proposal can be redrafted a fixed number of times (10 by default), so one proposal can't run up cost without end.

A proposal that went stale (ADR 0008: what it proposes changed elsewhere) or was already approved or declined can't be redrafted.

## Rejected

- **Decline and ask again.** It loses the context of what was nearly right, and the new proposal starts from nothing.
- **Edit the proposal by hand only.** Editing stays possible, but people asked the AI because they didn't want to write it, and a hand edit teaches nothing.
- **A new proposal per change.** It would leave several open proposals for one change in the Inbox, and the history of why it changed would be split across them.
- **Applying feedback directly, without approval.** Faster, but feedback can be misunderstood, and the Approve step is the product's core promise.
