---
status: done
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
- [x] Request changes on a Spec Proposal produces Redraft 2. The feedback is stored, and the diff from Redraft 1 is returned.
- [x] Pointing at one Choice redrafts the Choices with the pointer in the AI's input.
- [x] Approving after a Redraft applies only the approved Redraft to the Spec; the earlier Redrafts change nothing.
- [x] An approved, declined or stale proposal can't be redrafted (409). Request changes past the limit is refused.
- [x] Someone who can't approve the proposal gets a 403, and nothing is stored.
- [x] A preference in feedback ("answer in Thai, shorter") appears in the Conversation Summary's preferences.
- [x] Request changes from a Slack card produces a Redraft as the linked person; a press from another account changes nothing.
- [x] Browser-verified: Request changes on an Action Card, see Redraft 2 and its diff, approve it.

## Decisions
- **Schema** (migration `20261003130000_request_changes_redrafts`): one `Redraft` table for every kind of proposal, keyed by `ProposalKind` (`CHOICES`, `SPEC_PROPOSAL`, `BRIEF_PROPOSAL`, `FEATURE_SUGGESTION`) and `proposalId` (the Decision Request's id for Choices), plus one cascading foreign key per kind (a CHECK keeps exactly the right one set and equal to `proposalId`). Each row has `number` (unique per proposal), `status` (`WRITING`, `READY`), `content` (JSON, `RedraftContent` in `@vorasaan/shared`), `feedback`, `pointer`, `requestedById`, the AI's `summary` and `preferences`, and the model that wrote it (the 0054 columns). A partial unique index allows one `WRITING` Redraft per proposal.
- **The proposal always holds its latest READY Redraft.** Writing a Redraft updates the Spec or Brief Proposal's Markdown (and its model columns), the Feature Suggestion's fields, or replaces the Decision Request's Choices, in the same transaction that marks the Redraft READY, and only if the proposal is still as it was (PENDING, same base version; for Choices the same status and Decider). So Approve, which each service already does, applies only the current Redraft; the earlier ones change nothing. Redraft 1 (the proposal as first drafted, with its model) is stored when the first Request changes is made; a proposal never redrafted shows Redraft 1 read from the proposal itself.
- **Diffs** are line diffs (the shared `diffLines`, as for Spec Versions) of `redraftText(content)`: the Markdown as it is, Choices and a Feature Suggestion written out as Markdown. The web diffs two Redrafts' texts in the browser with the same component as Spec diffs.
- **API** (`@vorasaan/shared` `redraft.ts`): `POST {spec-proposals|brief-proposals|feature-suggestions}/:id/request-changes` and `POST /decision-requests/:id/choices/request-changes` take `RequestChangesInput` `{ feedback (1–4,000 chars), pointer? }` with a pointer `{ kind: CHOICE, label }`, `{ kind: SECTION, heading }` or `{ kind: LINES, from, to }`, and answer once the Redraft is READY with `RequestChangesResult` `{ redraft, redrafts, diff }` (the diff from the Redraft before). `GET …/redrafts` → `ProposalRedraftsView` (every Redraft, `current`, `writing`, `limit`, `left`, `canRequestChanges` and `reason` for the viewer); `GET …/redrafts/diff?from=&to=` compares any two. `POST /action-cards/:id/request-changes` does the same for a card and answers with the card, whose view now carries `redraft: { current, writing, left, feedback }`. `GET /redrafts/eval-cases[?kind=]` (Admins) exports every Request changes as `RedraftEvalCase` (before, feedback, earlier feedback, after, preferences, model).
- **Who:** exactly who may approve or decline: the approver of a Spec or Brief Proposal; the Project's POs and Admins for a Feature Suggestion (as dismiss); for Choices, the Raiser while DRAFT and whoever decides while OPEN (the Decider, or a Recipient while nobody has Claimed it). An Action Card adds its owner-only rule (404 for anyone else). Anyone else gets 403 before anything is stored or the AI is called.
- **When not:** approved, declined, rejected, dismissed, sent-and-decided, NEEDS_INFO, or stale (the Spec or Brief moved on) is a 409; a pointer to a part the proposal doesn't have (or the wrong kind of part) is a 422, as are Choices of a plain-text Question. A Request changes past the limit is a 409. The limit counts Request changes, not Redrafts: `VORASAAN_MAX_REDRAFTS`, default 10, so a proposal can reach Redraft 11.
- **While a Redraft is being written** "wait" means a 409, not a blocked request: Approve (Spec, Brief, accepting a Suggestion, sending or deciding a Decision Request) and another Request changes are refused until it is READY; the web disables the buttons and says "Writing Redraft N…". Decline is not held up; a Redraft that finishes after its proposal was declined or approved is dropped (409 to whoever asked). A WRITING row older than 10 minutes (a server that stopped mid-call) no longer blocks and is cleared by the next Request changes. Approve can also name the Redraft the person saw (`redraft` on the Action Card, Spec and Brief approve bodies): when another one is current by then, nothing is approved (409). The Spec and Brief approve re-read the proposal and check both inside their transaction.
- **A failed AI call** is a 502 that leaves the proposal as it was; the claimed number is freed.
- **AI:** four `AiPort` methods and prompts in `packages/skills` (`redraft-choices`, `redraft-spec-proposal`, `redraft-brief-proposal`, `redraft-feature-suggestion`), each given the current Redraft, the earlier feedback on the proposal (oldest first), the pointed-at part with its text, and the usual context (the Spec, retrieved Feature or Project context, the Brief and Guidelines). Each runs on the model of the task that drafted that kind (Choices, Spec Proposals, Grilling for Briefs, Feature Suggestions), with its own `VORASAAN_MODEL_REDRAFT_*` override. Feedback, earlier feedback and the pointed text are fenced as untrusted data (`<feedback>`, `<earlier>`, `<proposal>` added to `fence`); the prompt says feedback may only change the proposal's content and anything else is ignored and mentioned in `summary`. Whatever the AI returns is only ever written as the next Redraft of the same proposal, and it still needs Approve. Choices are relabelled A, B, C… in order whatever the AI wrote.
- **Preferences:** each redraft returns `preferences` (lasting ones only: language, length, tone, format). When the proposal came from a Conversation (an Action Card targets it), they are added to the Preferences section of its Conversation Summary, once each (case-insensitive), with an optimistic retry against a concurrent fold; an empty summary becomes one with only Preferences filled. The chat prompt and the next fold read them.
- **Chat Cards (0058 patterns):** a `redraft` action token (`r`) and a "Request changes" input on the decision card (all three apps) and on the Spec Proposal card (now its only button besides the link). Slack opens a modal, Teams shows an input on the card, LINE takes the next message (the 0058 reply prompt). The text goes through the same `RedraftsService.start` as the linked person; the bot replies "Writing Redraft N…", then "Redraft N is ready … <link>" (the Spec Proposal link carries `?redraft=N`, which opens that Redraft). A redraft of an OPEN request's Choices rebuilds the decision cards already sent (Slack and Teams edit them in place; on LINE the new card is sent as a reply to whoever asked; an old Choice button there finds its Choice gone and changes nothing). Thai and English strings.
- **SSE:** `proposal.redrafted` `{ kind, proposalId, number, status: WRITING | READY | FAILED }` to whoever may act on the proposal and whoever asked; the web refreshes the page on it. An Action Card's owner also gets `conversation.actionCard.updated` with the card's new Redraft.
- **Web:** "Request changes" next to Approve and Decline on every Action Card kind, on the Spec Proposal page, on a Decision Request (the Raiser's draft review, the Decider's decide form, and the Decision's Spec Proposal), on Brief Proposals and on Feature Suggestions (Project page). The Inbox links to those pages. The form takes the feedback and an optional "About" (a Choice or a section heading). A "Redrafts" switcher shows each Redraft with the feedback that caused it, who gave it and the model that wrote it, and the diff from any other; the Approve button names the Redraft it approves. Line pointers exist in the API but the web offers only sections and Choices.
- **Evals:** `bun run eval:redrafts` (apps/server) runs English and Thai cases for each kind, including a prompt-injection case; real feedback can be exported with `GET /redrafts/eval-cases`.
- **Tests:** `redrafts.api.test.ts` (Redraft 2 with feedback, pointer and diff; approve applies only the approved Redraft and refuses an old number; 409 for declined, stale and past the limit; 403 storing nothing; 422 pointers; WRITING blocks approve and a second request; a failed Redraft changes nothing; a Redraft finished after a decline is dropped; a pointed Choice in the AI's input and the Raiser/Decider rule; preferences in the Conversation Summary; Brief Proposal and Feature Suggestion; eval export; feedback fenced in the prompt), a Slack test in `decide-from-chat.api.test.ts` (another account's press changes nothing; the modal's text redrafts the Choices as the linked person and the sent card shows them), and `e2e/request-changes.e2e.ts` (an Action Card: Request changes, Redraft 2 and its diff, approve; Choices pointed at B before sending).
- **Left open.** Design Docs (0069) will use the same table with a new `ProposalKind`. A Redraft isn't streamed: the request waits for the whole call. Manual edits of Choices at send time aren't recorded as a Redraft.

