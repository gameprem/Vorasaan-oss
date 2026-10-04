---
status: done
depends-on: [0070]
slice: learning-loop
---

# 0071: Prompt Versions and in-app evals

## Goal
An Organization can hold its own versions of the AI's prompts, and an Admin can measure one against another before using it (ADR 0015).

## Scope
- **Defaults and Prompt Versions:** the prompts in `packages/skills` stay the defaults. An Organization can hold its own Prompt Versions of any prompt:
  - numbered, immutable, each naming who approved it and when;
  - a diff between any two, the way Spec Versions are compared (0020);
  - one active per prompt; rollback makes an earlier one (or the default) active again, and is itself recorded;
  - every Receipt (0070) names the Prompt Version it used.
- **Evals from Settings (Admin):** Settings → AI → Prompts lists each prompt, its active Prompt Version and its history. An Admin runs evals on a Prompt Version:
  - the checked-in eval sets (`bun run eval:*` cases, including Thai);
  - a replay of approved Receipts: the same inputs, scored against the approved output.
  The run is a background job on a real Approved Model the Admin picks, and shows progress, scores per case and the cost from its Receipts.
- **Compare:** scores of two Prompt Versions side by side, per eval set and per case, with sample outputs.
- **Editing:** an Admin can write a Prompt Version by hand; it is a proposal until approved, like 0072's.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [x] With no Prompt Version, every task uses the `packages/skills` default; once one is active, the task uses it and its Receipt names it.
- [x] Rollback makes the earlier version active, and the next call uses it.
- [x] The diff between two Prompt Versions is returned.
- [x] An eval run with the fake scores every case and stores the scores; comparing two runs returns both.
- [x] Replay picks only approved Receipts, and leaves out ones whose inputs were deleted by retention.
- [x] Only an Admin can approve, roll back or run evals (403 otherwise).
- [x] Runs on a real model are checked manually; automated tests use the fake.

## Decisions
- **Data model** (`packages/db`, migration `prompt_versions`):
  - `PromptVersion`: the Organization's version of one prompt (a `packages/skills` name), numbered per prompt **when written** (1, 2...; 0 always means the built-in default), immutable (only its status moves: `PROPOSED` → `APPROVED` or `DECLINED`), with who wrote, approved or declined it and when, the decline reason and a note.
  - `PromptActivation`: which version is active, as a log. The latest row of a prompt (by `seq`) wins; no row is the default. Approving a version writes an `APPROVE` row; a rollback writes a `ROLLBACK` row (to an earlier approved version, or `versionId` null for the default). So the history keeps every change, and only an approved version can ever be active.
  - `PromptEvalRun` and `PromptEvalCase`: an Eval Run of a version on an Approved Model, its sources (`CHECKED_IN`, `REPLAY`), progress (`done`/`total`), score, tokens, and each case with its score, checks, sample output (or error) and, for a replay, the Receipt replayed.
  - `Receipt.evalRunId`: the Eval Run a call was made for (null for the product's own calls).
- **Choosing the prompt.** `ModelRoutingAiPort` now also chooses the version of the task's prompt (`PromptVersionsService.choose`, in the global `MastraModule`) on every call, so an approval or a rollback applies to the next call. It travels in `AiCallOptions.prompt` (`PromptChoice`: name, version, number, template or null for the default). `MastraAiPort` renders the chosen template (partials expanded) instead of the built-in one (`PromptOptions.template` in `prompts.ts`); the `FakeAiPort` records it. `ReceiptingAiPort` hands it to the Receipt: `promptVersion` is `default@<hash>` for the default, `v<n>@<hash>` (12 hex digits of the SHA-256 of the expanded template, `promptVersionOf`) for a Prompt Version. A caller that passes `options.prompt` (an Eval Run) keeps it. `countTokens` chooses no prompt.
- **A version must render.** Written by hand, its template may use only partials that exist and exactly the placeholders the prompt is given, all of them but `{{cacheBreak}}` (422 otherwise): an unknown placeholder would fail every call, and a missing one would hide that input from the AI. Context budgets still count the default prompt's size (`skillTokens`).
- **Diff** like Spec Versions (0020): `diffLines` on the two templates as written (0 = the default's `packages/skills` source).
- **Checked-in eval cases** moved out of the `bun run eval:*` scripts into `apps/server/src/evals/cases/` (choices, spec-from-attachments, grilling, feature-suggestions, conversation, redrafts), which the scripts now import, so the script and the app run the same samples, Thai and mixed Thai-English included. The language checks of 0068 moved to `src/evals/language-check.ts`. A case scores the share of its checks passed: a valid answer (the task's schema held), each kept text and the language when it has an expectation, and its own checks (an injected instruction not followed, a follow-up asked or not, a PCI-breaking Feature found NOT_MET, nothing dismissed suggested again). The retrieval set stays a script: it measures retrieval, needs a seeded database, and has no prompt of its own. `draft-spec-proposal` has no checked-in cases (no script had any); it has the replay.
- **Replay** (`PromptReplay`) of the Choices (`generate-choices`) and of the Spec Proposal after a Decision (`draft-spec-proposal`): the 20 newest successful Receipts of the prompt that drafted a proposal with an `APPROVE` outcome, not from an Eval Run. Inputs are rebuilt from the records the Receipt points at (the request, its Decision, the Spec Version current when the call was made or the proposal's base), and context is retrieved again without the request itself. A Receipt whose records are gone (the request, proposal or Feature deleted) is left out, as are Receipts already deleted by retention. The score is the similarity to what was approved: the words of the Choices (Dice coefficient) or the lines of the approved Spec Version. Other prompts' outputs (Briefs, Feature Suggestions, chat replies) aren't replayed yet.
- **Eval Runs are background jobs** (`PromptEvalsService`): `POST` returns the run at once (`RUNNING`), its cases run one after another through `AI_PORT` with the version under evaluation, the Admin's Approved Model and each case's Reply Language, each stored with its score as it ends. Every call leaves a Receipt marked with the run; the run's tokens are summed from them (live while running, stored when done). Tokens are the cost shown: Approved Models carry no prices. A failing case scores 0 with its redacted error and the run goes on. A run left `RUNNING` when the server stopped is marked `FAILED` at the next start. `drain()` waits for runs (tests, shutdown).
- **API** (Admin only, `PromptVersionsController`, contracts in `@vorasaan/shared` `prompt-version.ts`): `GET /settings/ai/prompts` (`PromptsView`), `GET /settings/ai/prompts/:name` (`PromptDetailView`: default, active, versions, history, eval sets, replay count, runs), `POST …/:name/versions` (`CreatePromptVersionInput`), `POST …/:name/versions/:number/approve`, `POST …/:name/versions/:number/decline` (`DeclinePromptVersionInput`), `POST …/:name/rollback` (`RollbackPromptInput`, 0 = the default), `GET …/:name/diff?from=&to=` (`PromptDiff`), `POST …/:name/evals` (`StartPromptEvalInput`), `GET …/:name/evals/:runId` (`PromptEvalRunView`), `GET …/:name/evals/compare?a=&b=` (`PromptEvalComparison`). Unknown prompt or version: 404; approving a decided version or rolling back to the active one or to an unapproved one: 409.
- **Web**: Settings → **AI prompts** (`/settings/ai/prompts`, a new Settings section; the nav marks the longest matching section, so AI models isn't marked too) lists each prompt with its active version, versions waiting and eval cases. A prompt's page (`/settings/ai/prompts/[name]`, `components/prompt-versions.tsx`, on the UI kit) shows the active version, every version with Approve, Decline (with a reason) and Roll back, the template of each, the diff between any two (`VersionDiff`, now with its own caption), writing a version (prefilled with the active one), the history, and Evals: pick a version, an Approved Model and the sources, then the runs with their progress, scores per set and tokens, each run's cases with their checks, and two runs compared per set and per case with sample outputs side by side. While a run is in progress the page refreshes every 1.5 s. `SettingsLink` keeps links between Settings pages inside the modal.
- **Tests**:
  - `prompt-versions/prompt-versions.api.test.ts` (real Postgres, `FakeAiPort`): every task uses the default with no Prompt Version; once approved, the Choices call gets the version and its Receipt names it, other prompts keep the default, and a proposal changes nothing; an active template is what the prompt renders; numbering, validation (unknown or missing placeholder, unknown partial) and conflicts; rollback to v1 and to the default, recorded, and the next call uses it; the diff; an Eval Run scores every case, stores the scores and sums the tokens from its Receipts, and two runs compare; a failing case; a run's requirements; replay picks only approved Receipts, leaves out one whose request was deleted and an Eval Run's own, and nothing past retention; a Spec Proposal replay; 403 for a Member on every route.
  - `evals/eval-sets.test.ts`: every checked-in case runs and scores on the fake, the same twice; scoring.
  - `packages/skills`: `v<n>@<hash>` names and placeholders.
  - e2e `prompt-versions.e2e.ts`: an Admin writes a version, sees its diff from the default, runs evals on it and on the default, opens a run's cases, compares the two runs, approves it and rolls back to the default; a Member gets neither the page nor the API.
- **Checked by hand, not in automated tests**: runs on a real model (any `bun run eval:*` also still runs).

