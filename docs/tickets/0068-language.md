---
status: done
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
- [x] Prompt tests: every prompt carries the language rules.
- [x] Thai and mixed Thai-English eval cases are checked in for every eval set.
- [ ] The comparison is run manually and its result recorded in this ticket's Decisions. (Needs a real key: see "How to run the comparison" below. Everything else is done, so the status is `done`; this box is ticked when the results are filled in.)

## Decisions
- **One rules block, in every prompt.** `packages/skills/prompts/partials/language.md` is included in every template with `{{>language}}` (`loadSkill` expands it, an unknown partial fails, and `skillTokens` counts it). It says:
  - the call's reply language (`{{replyLanguage}}`: "English" or "Thai (ภาษาไทย)");
  - write what is produced for people in it, unless a rule of the task says which language a text keeps (an existing Spec or Brief keeps its own, so each document stays in one language);
  - the strategy line (`{{languageStrategy}}`): by default "think and write directly in the reply language; don't translate into English first, or draft in English and translate";
  - keep as written, never translated, transliterated, reworded or dropped: Vorasaan's terms (CONTEXT.md) and the Team Roles, the names of Projects, Features, Teams and people, product, library and protocol names, acronyms (SDK, HMAC, API), ids, ticket and issue keys (PAY-142) and versions (SDK 4.2), numbers with units, amounts, dates and times, code, field and file names, routes and URLs (with a Thai example sentence);
  - quote people's words exactly, in their language; never translate inside quotation marks, explain after the quote if needed;
  - when the reply language is Thai, every sentence is written in Thai and only the kept terms stay in English; input mixing Thai and English is normal and no reason to answer in English;
  - a last self-check: before answering, every kept term from the input appears exactly as written.

  **Tightened by ticket 0080 (2026-10-14)** after real-model evals on Gemini: kept terms were changed or lost ("PAY-142", "Async checkout", "SDK 4.2", "HMAC"), and replies to mixed Thai-English input were not Thai enough (a Thai Feature Suggestion Redraft came back 19% Thai, a mixed Thai-English Brief Proposal 59%, a mixed Conversation Summary 50%, against the 60% the checks ask). The last two rules replaced "Thai mixed with English is normal: answer in the reply language and keep the English words people used", whose second half the model read as leave to answer in English. It adds 62–63 tokens to every prompt; the 0076 token guards were raised by that, with the scores on the fake unchanged (Thai included). The rerun on a real model is manual (below).

  The block sits after each prompt's own rules, in its stable prefix, so a prompt is cached once per language (ticket 0061). The task-specific language lines stay (Choices follow the Decision Request's language, a follow-up the answer's, a summary the Attachment's, a Redraft keeps the proposal's), and wherever they said "if unclear, English" or guessed from the Project's name, they now say "the reply language". In chat, the person's latest message wins when it is clearly in another language.
- **Not translated.** Prompts stay in English and the model answers directly in the reply language; nothing is translated to English first. `MastraAiPort` takes a `LanguageStrategy` (`direct`, the product's; `english-first`, used only by the evals) that changes only the strategy line.
- **The person's language: no new setting.** A person already has one language setting, `ChatPreference.language` (0058, null = the Organization's since 0063). It now is "My language" for everything: chat cards, bot replies, their Grilling Conversations and the AI's replies to them. Settings → Notifications labels it "My language" and says so. A second `User.language` would let the two disagree, and the web UI's own language still follows the browser (0046), so no schema change and no migration. Only comments changed in `schema.prisma`.
- **Resolving it per call** (`apps/server/src/ai/language.ts`): `personLanguage(db, userId)` is the person's own, else their Organization's (`Organization.language`, 0063), else English; `projectLanguage(db, projectId)` is the Organization's, else English. `ChatAccountsService.languageOf` now uses `personLanguage`. `AiCallOptions.language` carries it into every AI call, and the prompt builders take a `PromptLanguage` (`{ language, strategy }`). Whose language each call uses:
  - the person whose action makes the call: a Conversation reply and its summary (the owner), Choices (the Raiser), the Spec Proposal after a Decision (the Decider), a Spec drafted from Attachments, a Feature Suggestion's first Spec, the fit check and Feature Suggestions (the person asking), every Redraft (who asked for changes), an Attachment summary (who added it), a Grilling follow-up (the Grilling Conversation's owner);
  - the Organization's for what a Grilling writes as it moves on, for a Team Role or the whole Project: the round's questions and the Brief drafted from every answer.
- **Grilling texts.** The server's Grilling Notes already existed in English and Thai (0047). A Grilling message's `content` (what text-only clients read) is now written in its owner's language instead of always English: the opening of each person's Grilling Conversation, every reply in it, and the "Brief drafted" note in the starter's language. The web keeps showing the Notes in the reader's browser language, as the rest of its UI. The rounds' names (Business, UX, Technical), Team Roles and "Grilling Conversation" / "Brief Proposal" stay in English in the Thai texts.
- **Tests.**
  - `packages/skills/src/index.test.ts`: every skill includes the partial exactly once; the expanded template contains the block and its placeholders; an unknown partial fails.
  - `apps/server/src/ai/language.test.ts` (FakeAiPort-free, pure): every AI task's prompt (a `Record<AiTask, …>`, so a new task must be added) contains the rendered rules once, with "English" by default and "Thai (ภาษาไทย)" when asked; Thai and mixed Thai-English input with a quote and an id (`ลูกค้าบอกว่า "จ่ายแล้วแต่ยังขึ้นว่ารอชำระ" ตั้งแต่ DR-12 …`) is in the prompt verbatim; the `english-first` variant swaps only the strategy line; the rules are in the cached prefix, the same across calls in one language.
  - `apps/server/src/ai/language.api.test.ts` (real Postgres, FakeAiPort records each call's `language`): English with nothing set; the Organization's when the person has none; the person's own wins either way; a Conversation reply asked for in its owner's language; Choices in the Raiser's language; Grilling questions in the Organization's; a Thai-speaking holder's Grilling Conversation opens and replies in Thai (`grillingNotesText(notes, 'th')`), an English-speaking one's in English, and the follow-up is asked for in Thai.
  - `packages/shared/src/grilling-notes.test.ts`: a Thai quote in a note is kept verbatim in both languages, and the Thai texts keep the domain terms.
- **Eval cases** (`apps/server/scripts/`, with `eval-language.ts` shared): Thai and mixed Thai-English cases in every set, each with the reply language and what must survive verbatim. They print `✓`/`✗` under the output and a total at the end (`══ eval:choices, direct: 5/6 language checks passed`, then each failure).
  - `eval:choices`: a Thai request quoting a customer with `PAY-142` and "10 นาที"; a mixed `PayFast SDK 4.2` / `HMAC` / `5 req/s` blocker; the existing Thai and English samples checked for language.
  - `eval:spec-from-attachments` (Spec Proposal): the Thai notes checked (`10 วินาที`, `LINE`, `ลองอีกครั้ง`); new mixed notes with `PAY-301`, `50,000 THB`, `PromptPay` and a quote; summaries checked too.
  - `eval:grilling` (Grilling and the Brief): Thai and mixed question rounds; a mixed follow-up without a number; a Brief drafted from Thai answers by "สมชาย" and "Nok" that disagree, keeping `1.5 ล้าน`, `KPI-07`, `WCAG 2.1 AA`, `PromptPay`.
  - `eval:feature-suggestions`: Thai and mixed suggestions (a Thai dismissed reason), a Thai first Spec keeping the suggestion's title, a Thai fit check of a Feature breaking the PCI Guideline (`PAY-210`).
  - `eval:conversation` (chat and the Conversation summary): Thai and mixed replies, one asked to quote the customer back (`"จ่ายแล้วแต่แอปยังขึ้นว่ารอชำระ"`, `PAY-142`); the Thai summary (`PAY-142`, `24`, `1.5M`) and a mixed one told to keep a quote (`SUP-88`, `"กด Pay แล้วหมุนค้าง 8 วิ"`, `Spec v3`).
  - `eval:redrafts`: the Thai cases checked; a mixed Spec Redraft quoting the PO with `PAY-142`, and a mixed Brief Redraft (`+5%`, `Q2`, `OKR-2027-03`).
  - `eval:retrieval`: the needle question in mixed Thai-English, checking the needle is still retrieved and the Choices are Thai with `22:30`, `12 THB` and `PromptPay`. It uses the server's own AI port, so it has no `--english-first` mode.

  A check passes when every listed string is in the output verbatim and the output is in the reply language: for Thai, at least 60% of its letters are Thai once kept strings, Vorasaan's terms, ids, routes and code are left out; for English, at most 5%. Fields the prompts ask for in English or as codes (`preferences`, labels, roles, levels, verdicts) are not counted.

### How to run the comparison (manual, real key)
Run each set twice from `apps/server`, with the same models (an `ANTHROPIC_API_KEY` or the provider the env vars name), and keep both logs:

```bash
cd apps/server
for set in choices spec-from-attachments grilling feature-suggestions conversation redrafts; do
  bun run eval:$set > /tmp/eval-$set-direct.log
  bun run eval:$set -- --english-first > /tmp/eval-$set-english-first.log
done
grep '══' /tmp/eval-*-direct.log /tmp/eval-*-english-first.log
```

(`VORASAAN_EVAL_LANGUAGE=english-first` does the same as `--english-first`.) Compare the totals, then read the Thai outputs side by side: are terms and ids kept, are quotes untouched, does the Thai read naturally (not like a translation), and are answers as good as the English ones? Note the time per call each run prints too. Record below which strategy wins; switch the product's default (`MastraAiPort`'s `languageStrategy`) only if `english-first` is clearly better.

### Comparison results
- TODO (manual, needs a real key): models used, the `══` totals for each set under `direct` and `english-first`, what reading the Thai outputs showed, and the decision. Until then the product answers directly.

## Left open
- The comparison above, and its decision.
- A person's language lives under Settings → Notifications ("My language"), next to the chat app preferences; a Profile section could hold it later. The web UI's own language still follows the browser (0046), so the Grilling Notes on the web follow the browser while their `content` follows the person's setting.
- Only English and Thai: adding a language means adding it to `ChatLanguage`, `LANGUAGE_NAME` and the Grilling and chat texts.
