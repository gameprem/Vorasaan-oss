---
status: done
depends-on: [0043, 0045]
slice: chat-web-ui
---

# 0046: Web: the chat view with Action Cards and a document panel

## Goal
A Conversation reads like Claude or Gemini: streamed replies, inline Action Cards, and the Spec or Brief open beside the chat.

## Scope
- Message list:
  - Markdown rendering.
  - Streamed text from `conversation.delta`.
  - A stop button.
  - Retry after an error.
- Composer: multi-line input, with Enter to send and Shift+Enter for a new line. Attaching a file or URL creates an Attachment through the existing API.
- Action Cards:
  - Decision Request draft: shows the Choices and Decider, with Edit and Send.
  - Spec Proposal or Brief Proposal: shows a diff, with Approve and Reject.
  - Feature Suggestion: Accept, or Dismiss with a reason.
  - Every card shows its state: PROPOSED, APPROVED, DECLINED or STALE.
- Document panel: the latest Spec or Brief opens on the right and can be closed. A pending proposal is shown as a diff there.
- New Conversation:
  - A greeting ("สวัสดี Pim", in the user's language) with starter cards. The cards come from the user's real pending work: an Inbox Item, a Grilling round waiting for them, a Feature without a Spec.
  - Inside a scope, the starters are chips, such as "Raise a Blocker", "Draft the Spec from the Attachments" and "Suggest Features".
- Under the composer: "The AI only proposes. Nothing changes until a person approves it."
- Visual design per ADR 0008 and `docs/design/chat-web-ui-mockup.html`:
  - AI replies have no bubble and are marked by the spark.
  - The user's messages are in a tinted bubble.
  - Action Cards use a soft shadow instead of a border.
  - The Spec panel is a rounded sheet.

## Acceptance criteria
- [x] Browser-verified with `VORASAAN_AI=fake`: ask for a Spec change → a card with a diff appears → Approve → the panel shows the new Spec Version.
- [x] The chat view matches the mockup in light and dark themes, checked with screenshots side by side.
- [x] Cards and replies keep working with the keyboard alone, and screen readers announce streamed text politely.

Tested: `apps/web/e2e/chat.e2e.ts` (a Feature Conversation streaming its reply; a scripted `draftSpecProposal` → Approve → the panel on the new Spec Version; Stop; Retry after a failed reply; dismissing a Feature Suggestion with the keyboard alone; Settings over a Conversation keeping its draft; an unknown URL is a 404). `apps/server/src/conversations/chat-view.api.test.ts` (real Postgres): stopping a reply, Action Card detail and approver, `TeamView` Spec Versions, the dev chat script. `shell.e2e.ts` follows the Sidebar's new links.

## Decisions
- **Route handlers, not Server Actions, for the chat's calls.** The client runs Server Actions one at a time, so a Stop pressed during a reply would wait for that reply. `app/api/conversations` (start), `app/api/conversations/[id]/{messages,retry,stop}` and `app/api/action-cards/[id]/{approve,decline}` forward to the API through `lib/api-proxy.ts`: same-origin check, the session's token added on the server, the body parsed with the shared Zod schema, the upstream path fixed. Attaching a link still uses the existing Server Action; a file uses the existing upload route.
- **One event stream.** `LiveUpdates` (the shell's `EventSource`) now also hands every `conversation.*` event on as a window event (`lib/conversation-events.ts`); the chat view listens there instead of opening a second stream.
- **The page renders the server's Conversation; the client keeps it live.** Deltas build the reply under its message id; `done`, `step`, `appended` and the turn's answer add stored messages; `actionCard.*` and an approve or decline answer update cards. A route refresh (after an approval, an Inbox change, a reconnect) merges new server data in by id, a reviewed card winning over an older PROPOSED copy. Each Conversation's view is keyed by its id.
- **A new Conversation** is started from `/conversations/new` with `POST /conversations`. Its id is unknown until the reply is stored, so while starting, the first `conversation.*` event names it (two tabs starting one at the same instant could mix their streams up; acceptable). On success the page moves to `/conversations/[id]`; after a 502 it moves to the Conversation the body names, which offers Retry.
- **Stop** (`POST /conversations/:id/stop` → 202 `{ stopped: true }`, 409 when no reply is being written, 404 for anyone but the owner): the service keeps an `AbortController` per reply being written (in-process, like the reply lock) and passes its signal to `AiPort.chat`. The text written so far is stored as the reply, the request that asked for it answers 201 as usual, and `conversation.done` is sent; the tool calls of the step being stopped never run. A reply stopped before any text is stored empty and shown as "Stopped before replying." A Grilling Conversation's turns are written by the server, so there is nothing to stop (409). `MastraAiPort` ends its stream once the signal aborts; `FakeAiPort` throws an `AbortError`, as a provider does.
- **Action Cards carry what they propose.** `ActionCardView.detail` (`ActionCardDetail`; null once the target is gone) is read from the target for every card view and event: a Decision Request draft's kind, description, Choices with their impact, the decider role and who would receive it (`DecisionRequestsService.candidates`, the routing Send uses, before Delegations); a Spec or Brief Proposal's two sides, its **approver** and, once approved, the version it wrote; a Feature Suggestion's rationale, value, effort, risk, dismiss reason and Feature. The client draws cards and the panel's diff from it without another request.
- **Waiting for the approver.** Only the proposal's approver approves or rejects it, so when `detail.approver` isn't the viewer the card shows "Waiting for <approver>" and no buttons. Today a Conversation's proposal always has its drafter as approver; the screenshot set the approver by hand.
- **Card states.** The pill says PROPOSED, APPROVED, DECLINED or STALE in words, with what it meant: "Approved · Spec v2", "Approved · sent", "Declined · dismissed", "Stale" (plus a line saying it changed elsewhere). A 409 on approve or decline refreshes the card.
- **Decision Request draft:** Send approves the card with the defaults (the suggested role, every eligible recipient); its label names the recipient when there is one ("Send to Mint"). **Edit opens the existing draft form** (`/requests/:id`), as 0043 planned; sending from there moves the draft on, so the card then shows STALE. Discard declines it.
- **Feature Suggestion:** Accept takes the default Team (0043). In a Project with several Teams where the person is PO in more than one, the API's 422 shows on the card; there is no Team picker yet. Dismiss opens a reason field (optional; the API's default reason otherwise).
- **Document panel:** a Feature Conversation shows the latest Spec Version (`GET /features/:id/spec-versions`), a Project Conversation the Project Brief (`GET /projects/:id/brief`), with a link to the Feature or Project page. The newest proposal still PROPOSED in this Conversation shows on top as a diff; proposals made elsewhere stay in the Inbox. Wider than 1180px it is open beside the chat by default; narrower it is an overlay, closed until the header's "Spec vN" chip opens it (Esc or × closes it; focus moves in and back). An approval refreshes the route, so the panel and the chip move to the new version.
- **New Conversation:** the greeting's language comes from the browser's `Accept-Language` (Thai when Thai ranks above English, else English), since no language preference is stored yet. Starters come from real pending work: Inbox Items (decide or Claim, answer the Decider, a Spec or Brief Proposal to approve), a Grilling round waiting (a link to the person's Grilling Conversation), a Feature they are a Role Owner of with no Spec (`TeamView` features gained `specVersion`), then "Suggest Features" for a Project; at most four. A starter picks its scope and fills the composer; it doesn't send. A scope picker (a Project or one of its Features) sits in the composer; inside a scope its starters become chips, followed by the scope's own suggestions.
- **Sidebar:** a Project or Feature opens `/conversations/open?project|feature=`, which redirects to its latest Conversation (for a Project, the latest Project-wide one that isn't Grilling) or to a new one there. The Feature or Project is highlighted on its page, on a new Conversation there, and on its Conversations the Sidebar lists as recent. The pages stay a click away: the chat header's crumbs link to the Project and Feature pages, and the panel has an "Open the … page" link.
- **Layout:** on `/conversations/*` the stage is the window's height (the thread scrolls, the composer stays), and stays so while Settings is open over it, so the scroll position and the draft survive. On a phone the shell's menu button sits in the chat's header instead of a second bar, and the chips scroll sideways in one row. The chat's styles are in `app/chat.css`, on the 0045 tokens.
- **Accessibility:** the thread is a `role="log"` with `aria-live="polite"` and `aria-busy` while a reply streams, so a screen reader reads the reply once complete; a status line says "Vorasaan is writing a reply." and "Reply stopped." Cards are `article`s named by their title; every action is a button or a link; Enter sends, Shift+Enter (or Enter while an IME composes) starts a new line.
- **Markdown** in replies and in the panel via `react-markdown` with GFM; raw HTML is never rendered, and links open in a new tab with `noopener`.
- **The model picker (0054)** has its place in the composer row, between "+ Attachment" and the context line; nothing is drawn there yet.
- **E2E scripting (dev only):** `POST /dev/fake-ai/chat-script` (`{ replies: [{ chunks, error?, chunkDelayMs? }] }`) queues the fake AI's next chat replies. It answers 404 unless the engine is `FakeAiPort` (`VORASAAN_AI=fake`) and dev sign-in is on. Its Zod schema stays in the server: it is not a product contract. `ScriptedChatReply` gained `chunkDelayMs`, so a reply can be watched streaming and stopped.
- **Follow-ups from 0045:**
  - Unknown URLs are 404 again: `@modal/[...catchAll]` is gone, and the intercepted Settings layout renders nothing once the URL leaves `/settings`, which is what the catch-all was for.
  - A stale dev identity cookie (a user the database no longer has) made the API refuse even its public routes, so `/login` threw. `/setup/status` and `/dev/users` are now called without the visitor's identity (`api(..., { anonymous: true })`), so the sign-in page and the user switcher work and you can switch to a real user.
- **Not here:** the Grilling header and progress (0047; Grilling Conversations render, with a "skip" chip and the Brief beside them); the model picker (0054); Decision and Attachment counts in the composer's context line (it names the scope and its Spec or Brief version); editing a Decision Request draft's Choices on the card itself.
