---
status: done
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
- [x] A Feature targets Back-End and Flutter, and its Spec has only a Back-End section. Coverage shows Flutter as missing because there is no Spec section.
- [x] If the Flutter Platform switches off its "Spec section" check, Flutter is no longer missing for that reason.
- [x] Nobody in the Team holds MOBILE, so Flutter is missing because there is nobody to ask. Adding a MOBILE member fixes that.
- [x] Flutter's section has no acceptance criteria, so Flutter is missing QA. Adding them, with a QA member in the Team, makes it QA ready. Without a QA member it stays missing, because nobody holds QA.
- [x] The input to Spec Proposal drafting contains the missing Platforms.

## Decisions
- **The rules are pure functions in `@vorasaan/shared` (`coverage.ts`)**, so the server, the AI's inputs, the fake and later the web app (0052) read a Spec the same way:
  - **Spec section**: a `##` heading (ATX, outside code fences, optional closing `#`s) equal to the Platform's name ignoring case and extra spaces, with content before the next heading of level 1 or 2. Content means a line that isn't blank, a heading, a fence marker, an HTML comment, a rule or the template's `- [ ] …` placeholder, so the empty sections `specTemplate` (0050) writes don't count as covered. Several sections with the name count if any has content.
  - **Someone to ask**: a `TeamMembership` of the Feature's Team holds one of the Platform's Team Roles (Role Owners and Delegations don't count; the ticket says "in the Team"). A Platform with no Team Roles and the check on is always missing it.
  - **No open Blockers**: Blockers `OPEN` or `NEEDS_INFO` (the same `OPEN_BLOCKERS` that makes a Feature Blocked; drafts and decided ones don't count) whose title, or a Choice's title or description, names the Platform. Its words are matched in order however they are joined ("Back-End" matches "backend" and "back end"), as a whole word for Latin letters and digits only, since Thai has no spaces between words. The description isn't read, as the ticket says: it often mentions other Platforms in passing.
  - **QA ready**: a non-empty `###` subsection of the Platform's section titled "Acceptance criteria", "Test cases", "เกณฑ์การยอมรับ" or "กรณีทดสอบ" (ignoring case and a final colon), and someone in the Team holds QA. Its gap says which of the two is missing (`noCriteria`, `noQa`), since only the first is something a draft can fix.
  - Only the latest Spec Version counts; a pending Spec Proposal covers nothing until approved.
- **Data**: one migration (`coverage`) adds `ACCEPTANCE_CRITERIA` to `SpecVersionSource`, for the AI's acceptance criteria drafts. Coverage itself is computed on read; nothing is stored.
- **API** (`CoverageModule`; contracts in `@vorasaan/shared` `coverage.ts`):
  - `GET /features/:id/coverage` (`FeatureCoverageView`): the Spec Version read, `covered` (every target covered, also true with none), and per target Platform in the Project's order its `checks` switched on and its `missing` gaps (`SPEC_SECTION`; `SOMEONE_TO_ASK` with the roles; `NO_OPEN_BLOCKERS` with each Blocker's id and title; `QA_READY` with `noCriteria`/`noQa`). Readable like `GET /features/:id`. `coverageGapText` gives each gap's words for 0052's chips.
  - `GET /projects/:id/coverage` (`ProjectCoverageView`): the Project's Platforms as columns, every Feature of its Teams as a row (by title) with a cell per Platform it targets, and `uncovered`: the Platforms no Feature covers (none targets them, or none that does is covered on them). Everyone in the Organization reads it (`projectAccess`, 404/403 as for the Platforms list).
  - Both read in a fixed number of queries run together, whatever the number of Features (the latest Spec Version of each Feature is one `DISTINCT ON` statement). Query budgets: `featureCoverage` 7 and `projectCoverage` 11, with two new scenarios in `perf/scenarios.ts` (the query-budget test now checks 14). The large Organization now gives every bench Project the built-in Platforms (ids from the database, so the random source and the rest of the data are unchanged) and makes every Feature target Back-End and Front-End, and every other one Mobile, so these scenarios have gaps to find.
  - `POST /features/:id/coverage/acceptance-criteria` (`{ platformId }`, in `SpecController`, since it drafts a Spec Proposal): see below.
- **The AI** (ADR 0009). New and changed prompts go through `AiPort` and `packages/skills`:
  - `draftSpecProposal` and `draftSpecFromAttachments` take `missingSections`: the target Platforms with the "Spec section" check on whose section the Spec being edited lacks (`CoverageService.missingSections`). Their prompts (`draft-spec-proposal`, `draft-spec-from-attachments`) gain a fenced `<platforms>` block and one rule: add a `## <Platform>` section for each, named as listed, from what the Decision (or the Attachments), the Spec and the context say, or else one open question for its Team Roles; never invent requirements. The Decision's rule "change only what the Decision requires" now also allows those sections. The replay of Spec Proposals (0071) passes them too, rebuilt from the base Spec.
  - **Redrafts and chat don't get them**: a Redraft changes only what the feedback asks (ADR 0013), and proposing "Add a Flutter section" from chat is 0052's Action Card. `draftSpecFromSuggestion` doesn't either: a Feature accepted from a Suggestion targets no Platform yet.
  - `grillingQuestions` takes `uncoveredPlatforms`, and the prompt asks one question that fits the round about them, unless what is known already answers it. **None are passed while no Feature of the Project targets any Platform**: until then the Project hasn't said which Platforms its Features ship on (0050 left existing Features targeting none), and asking about every Platform would be noise.
  - **QA not ready → acceptance criteria as a Spec Proposal**: a new task `draftAcceptanceCriteria` (prompt `draft-acceptance-criteria`, Settings task `SPEC_PROPOSAL`, env `VORASAAN_MODEL_DRAFT_ACCEPTANCE_CRITERIA`) drafts the complete next Spec with a `### Acceptance criteria` subsection (`### เกณฑ์การยอมรับ` in a Thai Spec) in the Platform's section, adding the section if needed, each criterion a testable checkbox traced to the Spec and the Decisions; what they leave open goes under "Open questions". Its input is the whole latest Spec and the Feature's retrieved context (its Decisions and requests first), with the Decision Request workflow's budget. It is **asked for, not automatic**: `POST /features/:id/coverage/acceptance-criteria`, by the Feature's PO or an Admin (who approves it, like a Spec from Attachments), refused (422) when the Feature doesn't target the Platform, has no Spec Version yet, or the section already has criteria or test cases (a missing QA holder isn't something a draft fixes). Nothing triggers drafts on its own, so no proposal appears that nobody asked for; 0052 puts the button next to "missing QA". It leaves a Receipt, can be redrafted with Request changes like any Spec Proposal, and records `ACCEPTANCE_CRITERIA` as its source.
  - Platform names are written by people: fenced and kept to one line like other names (`<platforms>` joins the fenced tags). No prompt-injection defence or language rule changed.
  - **FakeAiPort**: a missing section gets "- Open question for MOBILE: what must Flutter do for this Feature?"; the UX round asks one question naming the uncovered Platforms; acceptance criteria restate the Spec's general criteria and the Decisions in the context "On <Platform>: ...".
  - **Eval cases** (`evals/cases/coverage.ts`, `bun run eval:coverage`): Spec Proposals and Specs from Attachments with missing sections (English and Thai), Grilling with an uncovered Platform (English and Thai), acceptance criteria in English and in a Thai Spec, and a prompt injection inside a Decision. They give `draftSpecProposal` checked-in cases, and so a guard, for the first time.
  - **Token guards (0076), raised on purpose**: on the earlier eval cases the new block and rule cost about 60 tokens a call (`draftSpecFromAttachments` 1296 → 1356, `grillingQuestions` 1235 → 1290); with the Coverage cases the guarded means are 1337 and 1255, `draftSpecProposal` 1453 and `draftAcceptanceCriteria` 1345, scores unchanged or higher. On the product's own calls the large Organization's Features now target Platforms, so the drafts carry `<platforms>` and the approved Spec gains a section per Platform, which later calls read: each guard grew by 21 to 171 tokens (listed in `token-guard.ts`), and the scenarios now include one acceptance criteria draft (9819).
- `.gitignore` ignored every `coverage/` directory (test coverage reports), which hid the server's `src/coverage` module from git and Biome; it is now excepted.
- **Not here**: Platform chips, the matrix view, filters and the "Draft acceptance criteria" button are 0052; Design Docs read `FeatureCoverageView.platforms[].covered` in 0069.
- **Tests**: `packages/shared/src/coverage.test.ts` (section and subsection parsing in English and Thai, fences, placeholders, Blocker name matching, every gap and switched-off checks). `coverage/coverage.api.test.ts`, real Postgres and `FakeAiPort`: the ticket's five criteria; an open Blocker naming Flutter (not a draft, gone once decided); the Project matrix, `uncovered`, 404s; the Spec Proposal draft's input and output, without a switched-off Platform; Specs from Attachments; Grilling with and without targeted Platforms; the acceptance criteria draft (who may ask, refusals, nothing changes before approval, approval makes Flutter QA ready, its Receipt).
