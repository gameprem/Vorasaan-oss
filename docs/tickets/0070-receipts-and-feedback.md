---
status: done
depends-on: [0061, 0065]
slice: learning-loop
---

# 0070: Receipts and feedback

## Goal
Every AI call leaves a Receipt, and what people did with its proposal is linked to it, so the Learning Loop has something to learn from (ADR 0015).

## Scope
- **A Receipt per AI call**, written by the server for every task (Choices, Spec Proposals, Redrafts, summaries, Grilling, Feature Suggestions, the fit check, chat turns):
  - the task, the prompt's name and its Prompt Version (the `packages/skills` default until 0071);
  - the Approved Model and its provider;
  - tokens in and out, cache reads and writes (0061, 0064), and latency;
  - a reference to the output (the proposal, Redraft or message it produced), not a copy of it;
  - the proposal it belongs to, when there is one.
  A failed call leaves a Receipt too, with its error.
- **Human outcomes**, linked to the Receipt that produced the proposal:
  - Approve, or Decline with its reason;
  - Request changes with its feedback (0065), and the number of Redrafts before approval;
  - a manual edit after approval (for example a Spec edited by hand within a Spec Version of the approved proposal), with its size.
- **Settings → AI (Admin):** turn collection on or off (on by default) and set retention (90 days by default). A daily job deletes Receipts past it. Turning collection off stops new Receipts; existing ones follow retention.
- **Export:** `GET /settings/ai/receipts/export` streams JSONL, one Receipt per line with its outcomes. People's names, emails and Attachment contents are left out; people appear as stable per-export ids. The format is documented in `docs/receipts-export.md` with a sample, and notes that it can feed Reef or other tools. The existing Redraft eval-case export (0065) stays.
- **Contracts:** Receipt and export line schemas in `@vorasaan/shared`.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [x] Raising a Decision Request writes a Receipt for its Choices with the task, prompt, Prompt Version, model, tokens, cache reads and writes and latency from the fake's usage.
- [x] Request changes twice, then Approve: the Receipt's outcome shows Approve after 2 Redrafts, with both feedback texts.
- [x] Decline with a reason, and a manual Spec edit after approval, are linked to their Receipts.
- [x] With collection off, no Receipt is written; past retention, the job deletes Receipts and their outcomes.
- [x] The export holds no person's name or email and no Attachment content, and each line parses with the shared schema.
- [x] Only an Admin can change the settings or export (403 otherwise).

## Decisions
- **Where Receipts are written.** `ReceiptingAiPort` (`apps/server/src/receipts/`) sits between the model routing and the provider adapter: `AI_PORT = ModelRoutingAiPort(ReceiptingAiPort(engine))`. It sees the model chosen for the call, times it, sums the usage the adapter reports through a new `AiCallOptions.onUsage` (MastraAiPort reports each request's usage from the `[AiUsage]` log of 0061; a structured call retried after an invalid answer reports twice and the Receipt sums both), and hands the Receipt to `ReceiptsService.record`. Since tests replace only `AI_ENGINE`, every API test runs through it with the `FakeAiPort`, which now reports a fixed usage (`FAKE_USAGE`) and can be told to fail (`failures`). `countTokens` is not an AI call and leaves none. A stopped chat reply leaves a failed Receipt ("Stopped by the person").
- **Off the request path.** `record` and `outcome` return at once; the writes run in the background, are tracked so tests (and shutdown) can `drain()` them, and a failure is logged (`[Receipts]`) and dropped. An outcome waits for the Receipt writes in flight, so it always finds its Receipt.
- **What a Receipt holds** (`Receipt`): the task (`AiTask`) and its Settings task, the prompt's name (the `packages/skills` name) and Prompt Version, the model's source (`APPROVED_MODEL`/`ENV`), Approved Model id, provider model id and provider kind, the Reply Language, tokens in and out, cache reads and writes, latency, success and a short redacted error, a reference to the output (`outputKind` + `outputId`), the proposal it drafted or redrafted with the Redraft number, who asked, and when (the app's injectable clock).
- **Prompt Version until 0071**: `default@` and 12 hex digits of the SHA-256 of the built-in template with its partials expanded (`skillVersion` in `@vorasaan/skills`). It changes whenever the prompt's text does. 0071's numbered Organization versions will be stored in the same column.
- **No prompt text, ever.** Not stored by default and not as an opt-in: the Receipt references the output by id, and the prompt by name and version. A replay (0071) can rebuild a prompt from the referenced records while they exist. This keeps Attachment contents and people's words out of Receipts entirely.
- **Linking to the output.** Ids are chosen before the call (`randomUUID`, then written with that id) so the Receipt points at what the call produced: the Decision Request (Choices), the Spec or Brief Proposal, the Redraft row, the `batchId` of the Feature Suggestions generated together, the Conversation reply (`replyId`) or the Conversation (a summary), the Attachment, the Grilling round or question. The fit check stores nothing: no output. A Grilling moving on has no `requestedBy`.
- **Outcomes** (`ReceiptOutcome`) are linked to the Receipt that drafted the proposal (`receiptId`), and for a Redraft after the first also to the Receipt that wrote it (`redraftReceiptId`). The drafting Receipt is the call that wrote Redraft 1; for a Feature Suggestion, the `suggestFeatures` call of its batch; for a proposal drafted in a Conversation, the chat reply whose tool call made its Action Card. Recorded in each proposal's own service, so the web, the CLI, Action Cards and chat apps all count:
  - **APPROVE**: a Spec or Brief Proposal approved, a Feature Suggestion accepted, a Decision made with one of the AI's Choices (with `choiceLabel`). `redraftsBeforeApproval` is the approved Redraft's number minus one.
  - **DECLINE**: a Spec or Brief Proposal rejected (both reject endpoints, and an Action Card's Decline, now take an optional `reason`), a Feature Suggestion dismissed (its reason), a draft Decision Request withdrawn, or a Decision made with the Decider's own answer instead of the Choices ("Decided with an answer of their own").
  - **REQUEST_CHANGES**: when the Redraft is claimed, with the feedback and the Redraft it was given on.
  - **MANUAL_EDIT**, with its size in lines added plus removed: the Raiser editing the Choices before sending them, or a Spec or Brief Version written by hand **in the very next version** after the one an approved proposal created (the window is one version: a later hand edit is about the document, not the proposal).
- **Collection off** writes neither Receipts nor outcomes; existing ones follow retention. Settings live on `Organization` (`receiptsEnabled`, default true; `receiptRetentionDays`, default 90, 1 to 3650).
- **Retention**: `ReceiptsService.purge()` deletes Receipts older than the retention (their outcomes cascade) and any outcome older than it. `ReceiptsScheduler` runs it at start and every 24 hours; `VORASAAN_RECEIPTS_JOB=off` turns the timer off (tests run `purge()` with the fake clock).
- **API** (Admin only, `ReceiptsController`): `GET /settings/ai/receipts` (`ReceiptSettingsView`: enabled, retentionDays, count, oldestAt), `PUT /settings/ai/receipts` (`ReceiptSettingsInput`), `GET /settings/ai/receipts/export` (JSONL, streamed a page of 200 at a time with `Readable.from`). `GET /redrafts/eval-cases` is unchanged.
- **Export privacy**: people become `person-N`, stable within one export; every person's name (as written, at least 3 characters) and email in free text is replaced by their id, any other email by `[email]`; errors are cut to 300 characters with the call's key and anything key-like masked. People's own feedback text is otherwise kept: it is the signal. Format and a sample: [docs/receipts-export.md](../receipts-export.md), which notes it can feed Reef or other tools.
- **Contracts** in `@vorasaan/shared` (`receipt.ts`): `ReceiptSettingsView`, `ReceiptSettingsInput`, `ReceiptExportLine` (format `vorasaan.receipt/1`), `ReceiptExportOutcome`, `RejectProposalInput`, and the `ReceiptOutputKind` / `ReceiptOutcomeKind` enums (mirrored with Prisma in `enums.test.ts`).
- **Web**: Settings → AI models gains a Receipts section (`components/receipts-settings.tsx`, UI kit `Switch` and `Button`): the collection switch (saved at once), the retention in days, the count kept with the oldest date, and "Export (JSONL)", a download through the same-origin `app/api/settings/ai/receipts/export` route so the session token never reaches the browser.
- **Tests**:
  - `receipts/receipting.test.ts` (real Postgres, `FakeAiPort`): a `Record<AiTask, …>` of calls, so a new task fails until added; each writes exactly one Receipt with its task, prompt, Prompt Version, model, provider, language, the fake's usage, latency and link; retried usage is summed; a failed call (and a chat failing mid-stream) leaves a failed Receipt with the key and email masked; `countTokens` writes none; collection off writes none; a failing or hanging write never fails or delays the call; retention deletes old Receipts with their outcomes.
  - `receipts/receipts.api.test.ts`: raising a Decision Request writes the Choices' Receipt with the fake's usage; Request changes twice then Approve shows Approve after 2 Redrafts with both feedback texts (in the database and the export); a Decline with its reason, a hand edit after approval (and not a later one), and the Choices approved with their label; a dismissed Feature Suggestion links to its batch; a card declined in a Conversation links to the reply that drafted it; the export has no name, email, user id or Attachment content and every line parses; collection off and retention through the API; a failing Receipt write doesn't fail raising a request; 403 for a Member on all three routes; the Redraft eval cases still export.
  - `packages/skills`: Prompt Versions are `default@<hash>` of the expanded template, distinct per prompt.
  - e2e `receipts-settings.e2e.ts`: an Admin sees the count, turns collection off and on, sets the retention, downloads the export and checks it (parses, no emails or ids); a Member gets neither.
- **Fixed on the way: an Action Card turning STALE right after Approve** (seen once in CI in `chat.e2e.ts`). Approving a card calls the target's service (e.g. `SpecService.approve`), which publishes the Inbox change before `ActionCardsService.act` marks the card APPROVED. The web reloads the Conversation on that event, and `forConversation` saw a PROPOSED card whose proposal was already approved, so it marked it STALE; `mark` then left it STALE (it only changes a PROPOSED card). `forConversation` now skips cards being acted on in this process (`acting`). Regression test in `conversations/action-cards.api.test.ts` ("a reload while the card is being approved never turns it STALE"), which fails without the fix.
