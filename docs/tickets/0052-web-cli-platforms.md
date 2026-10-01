---
status: todo
depends-on: [0051, 0045]
slice: platforms
---

# 0052: Web and CLI: Platforms and Coverage

## Goal
People pick Platforms, see Coverage at a glance, and fix the gaps from where they work.

## Scope
- **Web:**
  - Settings modal → Platforms: edit the Organization template.
  - Project → Platforms: add, rename, reorder or remove Platforms; map Team Roles; switch checks on or off.
  - A Feature header shows one chip per target Platform: jade when covered, saffron when missing, with the reason on hover or tap.
  - Project Coverage view: a Feature × Platform matrix, filterable to "missing only" and by reason (for example "missing QA"), so QA can see which Platforms still need test cases.
  - In chat, the AI can propose "Add a Flutter section" as an Action Card (0043).
- **CLI:**
  - The Features tab shows each Feature's Platform chips.
  - `vorasaan raise` suggests the Platform from the files changed in the repository, for example `lib/**/*.dart` → Flutter. The suggestion is only a hint.

## Acceptance criteria
- [ ] Browser-verified: a Flutter Platform is added to a Project, a Feature targets it, and it shows as missing. A Spec section is added, and it shows as covered.
- [ ] The matrix is readable at 375px wide: it scrolls inside its own container, and the page doesn't scroll sideways.
