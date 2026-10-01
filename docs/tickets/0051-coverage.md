---
status: todo
depends-on: [0050]
slice: platforms
---

# 0051: Coverage per Platform, and the AI uses it

## Goal
Anyone can see which target Platforms of a Feature are covered and which are missing, and why. The AI fills the gaps it can and asks about the rest (ADR 0009).

## Scope
- `CoverageService.forFeature` and `forProject` evaluate only the checks each Platform has switched on:
  - **Spec section:** the latest Spec Version has a `##` heading matching the Platform's name, case-insensitive, with non-empty content under it.
  - **Someone to ask:** someone in the Feature's Team holds one of the Platform's Team Roles.
  - **No open Blockers:** no open Blocker names the Platform in its title or Choices.
  - **QA ready:** the Platform's section has a non-empty `###` subsection titled "Acceptance criteria" or "Test cases" (English or Thai: "เกณฑ์การยอมรับ", "กรณีทดสอบ"), and someone in the Team holds QA.
- API:
  - `GET /features/:id/coverage`.
  - `GET /projects/:id/coverage`: a Feature × Platform matrix.
- The AI:
  - Spec drafting and Spec Proposals get the missing sections as part of their input. They fill those sections, or add an open question to them.
  - Grilling asks about Platforms that no Feature covers.
  - When QA isn't ready for a Platform, the AI drafts its acceptance criteria from the Spec and the Decisions, as a Spec Proposal a person approves.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] A Feature targets Back-End and Flutter, and its Spec has only a Back-End section. Coverage shows Flutter as missing because there is no Spec section.
- [ ] If the Flutter Platform switches off its "Spec section" check, Flutter is no longer missing for that reason.
- [ ] Nobody in the Team holds MOBILE, so Flutter is missing because there is nobody to ask. Adding a MOBILE member fixes that.
- [ ] Flutter's section has no acceptance criteria, so Flutter is missing QA. Adding them, with a QA member in the Team, makes it QA ready. Without a QA member it stays missing, because nobody holds QA.
- [ ] The input to Spec Proposal drafting contains the missing Platforms.
