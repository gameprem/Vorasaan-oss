---
status: todo
depends-on: [0063]
slice: language
---

# 0068: Language: keep domain terms and quotes as written, and Thai eval cases

## Goal
The AI answers Thai teams in Thai without mistranslating what must stay exact, and we measure how well it does.

## Scope
- **Prompt rules**, in every prompt in `packages/skills`:
  - Keep domain terms as written: the CONTEXT.md terms, Feature names, ids, numbers and people's names.
  - Keep what people wrote, when quoted, in its original language.
  - Reply in the person's language; with none known, in the Organization's language (0063).
- **Grilling** questions and follow-ups follow the same rules.
- **Eval cases:** every eval set (`bun run eval:*`) gets Thai and mixed Thai-English cases that check terms, ids and quotes survive.
- **Measure, don't translate:** compare "answer directly in Thai" with "reason in English, answer in Thai" on the eval sets, and record the result here. Until the result says otherwise, prompts answer directly, without translating to English first.

## Acceptance criteria (test first)
- [ ] Prompt tests: every prompt carries the language rules.
- [ ] Thai and mixed Thai-English eval cases are checked in for every eval set.
- [ ] The comparison is run manually and its result recorded in this ticket's Decisions.
