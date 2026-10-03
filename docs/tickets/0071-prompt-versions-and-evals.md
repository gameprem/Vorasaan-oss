---
status: todo
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
- [ ] With no Prompt Version, every task uses the `packages/skills` default; once one is active, the task uses it and its Receipt names it.
- [ ] Rollback makes the earlier version active, and the next call uses it.
- [ ] The diff between two Prompt Versions is returned.
- [ ] An eval run with the fake scores every case and stores the scores; comparing two runs returns both.
- [ ] Replay picks only approved Receipts, and leaves out ones whose inputs were deleted by retention.
- [ ] Only an Admin can approve, roll back or run evals (403 otherwise).
- [ ] Runs on a real model are checked manually; automated tests use the fake.
