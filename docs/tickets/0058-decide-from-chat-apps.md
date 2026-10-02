---
status: done
depends-on: [0057]
slice: decision-speed
---

# 0058: Decide from LINE, Slack and Teams

## Goal
A Recipient answers a Decision Request without opening Vorasaan (ADR 0011).

## Scope
- **Cards:**
  - When a request is sent to a linked person, they get a card in their chat app: Flex Message on LINE, Block Kit on Slack, Adaptive Card on Teams.
  - The card shows the title, the kind (Blocker in seal red), the Choices with their impact, the due time, and buttons for each Choice, Ask for more info, and Open in Vorasaan.
- **Buttons:**
  - A button press is checked against the linked account, then calls the same `DecisionRequestService` method as the web app.
  - "Ask for more info" opens the provider's text input (a modal on Slack and Teams, a reply prompt on LINE).
  - "Write your own answer" is offered the same way when the request allows it.
- **When something changed:** if the request was decided, claimed by someone else, or withdrawn, the reply says so (for example "Already decided by Nok: Choice A") and the card is updated where the provider allows it.
- **Other cards:** NEEDS_INFO questions go to the Raiser, and escalation reminders from 0055 go to whoever they target. Spec Proposals only get a "Review in Vorasaan" link.
- **Language:** card text follows the person's language. The fixed UI strings exist in Thai and English.

## Acceptance criteria (test first, real Postgres, fake provider servers)
- [x] Pressing Choice B on a Slack card decides the request as that person, and the Decision Log records the source as Slack.
- [x] A press from an account linked to someone else, or with no link, is refused and changes nothing.
- [x] Pressing a Choice on a card for a request that was already decided returns the "already decided" reply and doesn't change the request.
- [ ] Manually verified against a real LINE channel and a real Slack workspace, using test accounts. **Not done:** it needs real provider accounts and a public HTTPS address, which the build environment doesn't have. Steps below.

`status: done` covers everything but that manual check. The same three criteria are also tested for LINE and Teams (`apps/server/src/chat-apps/decide-from-chat.api.test.ts`).

## Decisions
- **Where it is wired.** Decision Requests and escalation don't know about chat apps: they add a `ChatCardSignal` to the Outbox they already fill inside their transaction (`outbox.chatCard(...)`), and `NotificationsService.publish` hands the signals, after the commit, to `ChatCardSignals` (Inbox module). `ChatCardsService` (chat apps module) listens and sends in the background, never awaited by the web action. This keeps one direction of dependency: the chat apps module imports Decision Requests (a press decides through it), never the reverse.
- **Which change sends which card** (`ChatCard.event` is the preference it falls under):
  - submit → a decision card to each Recipient (`DECISION_REQUEST`);
  - the Decider's QUESTION → a NEEDS_INFO card to the Raiser, with the question and an "Answer in Vorasaan" link (answering stays in the web app);
  - the Raiser's ANSWER → the decision card again to the Decider, with "Beam answered: …" (`DECISION_REQUEST`), so the whole NEEDS_INFO round can happen in chat;
  - escalation step 1 → a reminder decision card to whoever it waits on (`ESCALATION`); step 2 → a decision card to each Delegate added (`DECISION_REQUEST`: to them it is a new request sent to them, so it follows that preference, not `ESCALATION`, which is off by default); step 3 → an overdue notice with a link to the Raiser and Tech Leads (`ESCALATION`);
  - a Decision → a "Review in Vorasaan" link to its Spec Proposal, to the person who decided (`SPEC_PROPOSAL`, off by default). Other Spec Proposals (from Attachments, Conversations, Feature Suggestions) are made by someone at the web app, so they get no card.
- **One `ChatCard` row per person per linked chat app** (`userId`, `provider`, `event`, `requestId`/`specProposalId`, `escalationStep`, `status` PENDING/SENT/SKIPPED/FAILED, `messageRef`). The card's content is built from the request as it is at send time, and a card that no longer matters then (decided, withdrawn, Claimed by someone else, answered, proposal reviewed, unlinked, chat app off) is SKIPPED, not sent.
- **Quiet Hours: held, then sent.** A card due during the person's Quiet Hours is stored PENDING; `ChatCardsScheduler` runs `ChatCardsService.flush()` every minute (`VORASAAN_CHAT_CARDS_JOB=off` turns the timer off, as tests do) and sends it once Quiet Hours end, rebuilt from the current state, or SKIPS it if it no longer matters or the person switched that kind off meanwhile. Rationale: skipping would lose exactly the Blockers chat apps are for, while a morning card for something already decided is noise, which the staleness check removes. A card is claimed with a conditional update before it is sent, so two instances never send one twice. The Inbox has everything meanwhile (CONTEXT.md, Quiet Hours).
- **Sending never blocks or fails the web action.** Cards are sent after commit, in the background; a provider error marks the card FAILED and logs only "SLACK API call failed (HTTP 500)" (provider and status, as in 0057), never a URL, body or token. One person's failure doesn't stop the others'.
- **What a card carries (ADR 0011):** title, kind (Blocker on seal red `#B8321F`: Slack's attachment bar, LINE's header box, Teams' `attention` container), the Feature's title, "From {Raiser}", the due time with 0055's label in the person's time zone and language ("Due Fri 2 Oct, 17:00 (in 2h)", "paused" during NEEDS_INFO), each Choice's label, title and Scope/Time/Risk impact (each cut at 300 characters), and quoted thread text (a question or answer) cut at 500. Never the request's description, a Choice's description, a Snapshot or the Spec Proposal's Markdown. Text is escaped for Slack mrkdwn, so a title can't mention @channel or become a link.
- **Buttons:** Choose A/B/C…, Ask for more info, Write your own answer (always offered: the web app always allows an own answer; LINE shows "Own answer", labels being limited to 20 characters), and Open in Vorasaan (`VORASAAN_WEB_URL`, default `http://localhost:3000`, new in `.env.example` and `docker-compose.yml`).
- **Button payloads (ActionToken, `action-token.ts`):** `v1.<card id>.<c|a|o>.<choice id or ->.<mac>`, the MAC a 192-bit truncated HMAC-SHA256 under a key derived from `VORASAAN_SECRET_KEY` for this purpose only; at most 128 characters (LINE postback data allows 300). It names a card, never a person: **who pressed comes only from the provider's verified user id → `ChatAccount`**. A press then must be on a card sent to that same person in that same chat app (`card.userId`, `card.provider`); else "This card was sent to someone else" or "isn't linked", and nothing changes. An edited token (another Choice, another card) fails the MAC; even a valid one for someone else's card fails the ownership check; and the service then applies the web's own rules (only the Decider or a Recipient while unclaimed may decide). No "card version": a request's Choices can't change after it is sent, and what can change (status, Decider) is read at press time.
- **Same service as the web.** A Choice calls `DecisionRequestsService.decide(user, id, { choiceId }, source)`, an own answer `decide(..., { customAnswer })`, a question `postMessage(..., { kind: 'QUESTION' })`, with the same Zod inputs as the web. Their refusals map to replies: Conflict (someone acted at the same moment) re-reads and says what happened, Forbidden "You can't decide this", BadGateway "drafting the Spec Proposal failed" (nothing recorded).
- **Changed state:** before acting, a press reads the request: decided → "Already decided by Nok: Choice A: …" ("You already decided this: …" for oneself), withdrawn → "Withdrawn by Beam", Claimed by someone else → "Nok has Claimed this… open it in Vorasaan to Claim it back", NEEDS_INFO → "Waiting for Beam to answer the question first". The card is then replaced by that outcome without buttons on Slack (`chat.update` on the stored `{ channel, ts }`) and Teams (update activity on the stored `{ serviceUrl, conversationId, activityId }`); LINE can't edit, so only the reply says it. Other people's cards for the same request are not updated when it is decided (left open below); pressing them answers "already decided".
- **Decision source:** `Decision.source` (`DecisionSource`: WEB, CLI, LINE, SLACK, TEAMS; migration `20261002140000_decide_from_chat_apps`, existing Decisions default to WEB). The HTTP route records CLI when the caller authenticated with a Personal Access Token (the CLI's), else WEB. It is in `DecisionView.source` and `DecisionLogEntry.source`; the web shows "Decided by Pim in Slack" on the request page and in the Decision Log (nothing extra for the web app).
- **Text inputs:**
  - **Slack:** the button's `block_actions` carries a `trigger_id`; the server opens a modal (`views.open`) whose `private_metadata` is the same signed token, and the `view_submission` (form-encoded, signature-checked like every callback) brings the text back. The callback answers an empty 200 at once (Slack's 3-second limit; it closes the modal), and the outcome arrives as a direct message.
  - **Teams:** the card's Ask for more info and Write your own answer are `Action.ShowCard`s holding an `Input.Text` and an `Action.Submit`, so the text arrives with the press as `value.text` (no task module needed).
  - **LINE** (no modals): the postback arms a **reply prompt** for that chat account: its next text message within 10 minutes is taken as the question or answer; "cancel"/"ยกเลิก" disarms it, and any other press or message after the 10 minutes is handled normally. The prompt is kept in memory per chat account (like 0057's SeenEvents: one server process per Organization), taken once, and the ownership checks run again on the typed text. "unlink" or a link code sent while a prompt is armed disarms it and is handled as itself.
- **Presses are answered in the background.** Deciding drafts the Spec Proposal with the AI, which can outlast Slack's 3 seconds and LINE's reply token, so a callback is acknowledged at once and the press handled after (`ChatEventsService.drain()` in tests). LINE replies with the reply token and, when LINE refuses it as expired (400), pushes to the same person instead. Slack replies go to the presser's own direct message (posted to their user id), never to wherever a card was shared.
- **Replays:** a press repeated with the same provider event id (Slack `trigger_id` or modal `view.id`, LINE `webhookEventId`, Teams activity id) is dropped by 0057's SeenEvents; a later, new press on a decided request answers "You already decided this" and changes nothing.
- **Language:** a new `ChatPreference.language` ("en" or "th"; null = English), chosen in Settings → Notifications next to Quiet Hours. Vorasaan had no language preference, and no Organization language exists, so English is the default. All fixed card and bot text, including 0057's link and unlink replies, is in `chat-text.ts` in both languages; product terms (Blocker, Question, Choice, Spec Proposal, Claim) stay in English in Thai text, as CONTEXT.md names them. A chat account that isn't linked yet is answered in English. Dates use `en-GB`/`th-TH` formatting in the person's Quiet Hours time zone.
- **API** (Zod): `ChatPreferencesInput.language` (optional: left out keeps the stored one), `ChatPreferencesView.language`, `ChatLanguage`, `CHAT_LANGUAGE_LABEL`, `DecisionView.source`, `DecisionLogEntry.source`, `DECISION_SOURCE_LABEL`, `DecisionSource` and `ChatCardStatus` enums. No new routes: presses arrive at 0057's `POST /chat-apps/:provider/events` (Slack: also set it as the Interactivity request URL, now said in Settings → Chat apps).

### Manual verification (not done; to do with test accounts)
1. Expose the server over HTTPS (e.g. `cloudflared tunnel --url http://localhost:4000`), set `VORASAAN_WEB_URL` to the web app's address, start with `VORASAAN_AI=fake` or a real key.
2. **Slack:** create an app in a test workspace with scopes `chat:write`, `im:history`; Event Subscriptions → `https://<tunnel>/chat-apps/slack/events`, bot event `message.im`; Interactivity → the same URL; enable the Messages tab in App Home. Install it, enter the bot token and signing secret in Settings → Chat apps.
3. **LINE:** create a Messaging API channel; webhook URL `https://<tunnel>/chat-apps/line/events`, "Use webhook" on, auto-reply off; enter the channel access token and secret. Add the bot as a friend from a test LINE account.
4. As two test people (Pim, Nok, both PO Role Owners of a Feature; Beam the Raiser), link each chat account with a code from Settings → Notifications.
5. Beam sends a Blocker to "all POs". Check on both apps: the card arrives with a red header/bar, the title, Choices with Scope/Time/Risk, the due time, the buttons, no description.
6. Pim presses Choice B on Slack: the reply says "Decided: Choice B… Spec Proposal is ready to review: <link>", the card loses its buttons, the request page and the Decision Log say "in Slack".
7. Nok presses Choice A on LINE: the reply says "Already decided by Pim: Choice B: …"; nothing changes.
8. On a new request: Ask for more info on Slack opens a modal; the question reaches Beam's chat; Beam answers in Vorasaan; the card returns to Pim with the answer. On LINE: Ask for more info, then type the question as the next message.
9. Switch Pim's language to Thai: a new card's buttons read "เลือก A"…; set Quiet Hours around now: a new card arrives only when they end.
10. Forward/share a card to another person (or press with another account): "This card was sent to someone else".

### Left open
- Cards of other people (and other chat apps) are not updated when a request is decided, Claimed or withdrawn elsewhere; pressing them answers "already decided". Updating them proactively needs a signal on those changes too.
- The LINE reply prompt and the dropped-repeat memory are per process (as in 0057); several server processes would need them in a shared store.
- Teams `TextBlock`s render a Markdown subset, so a title written as a Markdown link shows as a link in Teams; titles are written by the Organization's own people.
- Teams uses `Action.Submit` (personal chat) rather than Universal Actions (`Action.Execute`), so a Teams card is updated by the bot after the press rather than refreshed per viewer.
- An Organization-wide default language, and reading LINE's or Teams' own locale, would spare Thai teams switching one by one.
- The manual check above.
