---
status: done
depends-on: [0032]
slice: project-foundation
---

# 0034: Feature Suggestions and the Guidelines fit check

## Goal
The AI proposes Features that serve the business, and checks any Feature idea against the Feature Guidelines (REQUIREMENT §3.8).

## Scope
- `POST /projects/:id/feature-suggestions/generate` (the Project's POs and Admins). It creates up to N `FeatureSuggestion`s from:
  - the Brief,
  - the effective Guidelines,
  - capability gaps,
  - the Decision Log,
  - previously dismissed suggestions and their reasons.

  Each suggestion has a title, rationale, business value, effort, risk, and which Guidelines it serves.
- **Accept** → creates a Feature (DRAFT) in the chosen Team, with a `SpecProposal` (`source: AI_SUMMARY`) for the accepting PO to approve.
- **Dismiss** requires a reason.
- **Fit check:** `POST /projects/:id/feature-fit` `{ title, description }` returns, for each effective Guideline, met / unclear / not met with a one-line reason, plus questions for the unclear ones. Used when creating a Feature by hand.
- The Brief and the effective Guidelines are added to the context of Choice generation and Spec Proposal drafting.
- Migration for `FeatureSuggestion`. `AiPort` methods, prompts, `FakeAiPort` and eval cases.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [x] Generate → accept one → a DRAFT Feature exists with a PENDING Spec Proposal. Dismiss another with a reason, and the next generation's AI input includes that reason.
- [x] The fit check reports one line per effective Guideline.

## Decisions
- Accept is allowed to a PO of the chosen Team or an Admin; the Team must belong to the suggestion's Project (422 otherwise).
- The accepter becomes the new Feature's PO Role Owner **only if** they hold the PO Team Role in that Team, because Role Owners are always members of their Team (0012) and Claim and routing rely on it (0016). An Admin outside the Team gets a Feature with no Role Owner; Admins set Role Owners later through the existing endpoint. Either way, the accepter is the Spec Proposal's approver.
- Effort and risk are LOW / MEDIUM / HIGH. `servesGuidelineIds` records the effective Guidelines at the time of generation.
