---
status: todo
depends-on: [0065, 0071]
slice: learning-loop
---

# 0072: The AI proposes better prompts

## Goal
The AI turns accumulated feedback into a proposed Prompt Version with evidence, and an Admin decides whether to use it (ADR 0015).

## Scope
- **Analysis per task:** on demand from Settings, or when a task has enough new feedback (configurable, 20 outcomes by default), the AI reads that task's Receipts and outcomes and names the patterns, for example "Choices often asked to be shorter" or "Spec Proposals often declined for missing error cases", each with the number of cases and links to them.
- **Proposal:** from the patterns, the AI proposes a new Prompt Version of the task's prompt, with its rationale.
  - Evals (0071) run on it automatically, against the active Prompt Version.
  - The proposal shows the patterns, the diff, before and after scores, and sample outputs side by side.
- **Decide (Admin):** Approve makes it the active Prompt Version; Decline takes a reason; Request changes asks for a Redraft (0065), with a new `ProposalKind` for Prompt Versions, and its evals run again. Rollback works as in 0071.
- **Never publishes by itself.** Nothing changes until an Admin approves, even if every score improves.
- **The prompt** for the analysis and the proposal lives in `packages/skills`, with eval cases including Thai feedback.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] With 20 scripted "shorter please" outcomes on Choices, the analysis names the pattern and a Prompt Version is proposed with a rationale.
- [ ] Evals run on the proposal, and its before and after scores are returned with sample outputs.
- [ ] Approve makes it active; Request changes produces Redraft 2 and reruns evals; Decline stores the reason.
- [ ] Without approval, every task keeps using the active Prompt Version, even when the proposal scores higher.
- [ ] Only an Admin can approve, decline or request changes (403 otherwise).
