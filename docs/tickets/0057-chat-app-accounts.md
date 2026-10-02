---
status: done
depends-on: []
slice: decision-speed
---

# 0057: Link a LINE, Slack or Teams account

## Goal
A person connects their chat app account to Vorasaan safely, so cards and buttons can act for them (ADR 0011).

## Scope
- **Admin setup** (Settings → Chat apps): turn LINE, Slack or Teams on, entering that provider's credentials.
  - LINE needs a channel access token and a channel secret.
  - Slack needs a bot token and a signing secret.
  - Teams needs a bot app id and password.
  - Credentials are stored in `OrgIntegration`, encrypted with `VORASAAN_SECRET_KEY`.
- **Linking:**
  - In Settings → Notifications, the person gets a one-time code that is valid for 10 minutes. They send it to the bot, and the bot confirms the link.
  - `ChatAccount` stores the person, the provider and the provider's user id.
  - Unlinking works from either side.
- **Callbacks:** `POST /chat-apps/:provider/events` checks the provider's signature before reading anything. A bad signature gets 401 and nothing is logged beyond that.
- **Preferences:** each person chooses which events go to the chat app, by default Decision Requests and NEEDS_INFO, and sets quiet hours.

## Acceptance criteria (test first, real Postgres, fake provider servers)
- [x] A valid code links the account. An expired, reused or wrong code doesn't.
- [x] A callback with a bad or missing signature is rejected for each of the three providers.
- [x] Credentials never appear in API responses or logs.

## Decisions
- **Which Organization's secret checks a callback.** The one Organization of the instance (the oldest, as Atlassian and AI providers already assume: self-hosted, one Organization per instance). The path stays `POST /chat-apps/:provider/events` with no Organization in it, so the URL an Admin pastes into LINE, Slack or Azure never exposes an internal id; each chat app is an `OrgIntegration` (`LINE`, `SLACK`, `TEAMS`), at most one each per Organization (partial unique index). A Link Code also records its Organization, and linking only accepts a code of the Organization whose secret verified the callback, so a second Organization later can't cross-link. Hosting several Organizations would move to a per-integration path segment (`/chat-apps/:provider/:integrationId/events`) without changing the adapters.
- **Verified before read.** A route marked `@VerbatimBody()` (`apps/server/src/http/verbatim-body.ts`) gets its raw bytes from a Fastify `preParsing` hook (at most 1 MiB, else 413) and Fastify never parses it, so a malformed or non-JSON body is still a 401 when unsigned, not a 400. The handler loads the Organization's credentials, the adapter checks the signature over those bytes, and only then parses. Every failure (no integration, missing or bad signature, a body that contradicts the token) is the same bare 401, and nothing is logged. Comparisons use `timingSafeEqual`.
  - **LINE:** `x-line-signature` = base64 HMAC-SHA256 of the raw body with the channel secret. LINE signs no request time, so each event's own `timestamp` (inside the signed body) must be under an hour old, and a repeated `webhookEventId` is dropped.
  - **Slack:** `x-slack-signature` = `v0=` + hex HMAC-SHA256 of `v0:{x-slack-request-timestamp}:{raw body}` with the signing secret, and the timestamp within 5 minutes of now (either way). Inside the window a repeated `event_id` is dropped (this also absorbs Slack's retries). URL verification is answered only once signed.
  - **Teams:** `Authorization: Bearer` JWT, RS256 only (no `none`, no HMAC), its `kid` in the Bot Framework's JWKS (fetched from the OpenID metadata, same origin only, cached a day; an unknown kid refetches at most every 5 minutes), issuer `https://api.botframework.com`, audience the bot's app id, `exp`/`nbf` with 5 minutes of skew, and a `serviceurl` claim. After parsing, the activity's `serviceUrl` must be that claim (so a reply, carrying the bot's access token, only goes to Microsoft's connector) and its `channelId` among the key's endorsements. The key source is injectable (`TEAMS_KEY_SOURCE`); tests point it at a fake JWKS.
  - Dropped repeats are remembered in memory for 2 hours (`SeenEvents`), longer than every window above. Like the EventBus, that assumes one server process.
- **Link Codes:** 10 characters of Crockford base32 (50 random bits), shown as `ABCDE-FGHJK`; typed in any case, with or without the dash or spaces or a leading "link", O read as 0 and I/L as 1. Only a SHA-256 is stored (`ChatLinkCode.codeHash`), with its provider, Organization and a 10-minute expiry; it is consumed with a conditional update, so it works once even under concurrent callbacks. A new code replaces the person's earlier unused one for that chat app, and a code only works in the chat app it was made for. Guessing: a chat account gets 5 wrong codes per 15 minutes, then even a right one is refused until the window passes (in memory). With 2^50 codes, that leaves no practical brute force.
- **Chat Account:** `ChatAccount` (person, Organization, provider, provider user id, an `address` to send to later, and a display name when the provider gives one), unique per provider user (one person per chat account) and per person and provider (a new link replaces the old one). A chat account linked to someone else can't be linked again until it is unlinked; the bot says so without naming anyone. Only one-to-one chats count (LINE `source.type = user`, Slack `channel_type = im`, Teams `personal`): in a group anyone could read the reply.
- **Unlinking:** from Vorasaan (`DELETE /me/chat-apps/:provider`, and the bot tells the chat account), or from the chat ("unlink", or blocking the LINE bot / removing the Teams app). An Admin turning a chat app off deletes its credentials, links and pending codes; giving Teams a different bot app id ends the Teams links, because a Teams user id is per bot. Rotating a secret or token keeps everyone linked.
- **Credentials:** stored as one AES-256-GCM-encrypted JSON object per chat app (`secretEncrypted`, `VORASAAN_SECRET_KEY`), the Teams app id in plain `appId` (it is the JWT audience, not a secret). Views return `secretsSet` only; a save may leave secrets out to keep them, the first needs them all, and a stored Teams password is only reused for the same app id. Provider API errors carry the provider and HTTP status only; a stored blob that doesn't decrypt or parse fails without its content. Provider calls refuse redirects and time out after 5 seconds. Tests assert that no secret appears in any response or log line, including a failing reply.
- **Adapters for 0058** (`apps/server/src/chat-apps/adapters/`): one per provider with `verify` (raw bytes only), `parse` (normalized `message` / `unlinked` events, each with a `reply`) and `send` (to a linked account's stored address: LINE push, Slack `chat.postMessage` to the DM channel, Teams proactive activity with a cached client-credentials token). 0058 adds a card `ChatMessage` and an `action` event; Slack's form-encoded interactive payloads already reach the adapter verified and are ignored for now. `ChatAccountsService.deliveryPreferences` plus `chatDelivery()` (`delivery.ts`) answer whether a kind of card may be sent now.
- **Preferences** (`ChatPreference`, `GET/PUT /me/chat-preferences`): which of Decision Requests, NEEDS_INFO, Spec Proposals and escalations go to chat apps (no row: Decision Requests and NEEDS_INFO), and Quiet Hours as a start and end time (across midnight when the end is earlier) in the person's own time zone or, by default, the Organization's.
- **API** (Zod in `packages/shared/src/chat-apps.ts`): `GET /settings/chat-apps`, `PUT /settings/chat-apps` (a union on `provider`), `DELETE /settings/chat-apps/:provider` (Admins); `GET /me/chat-apps`, `POST /me/chat-apps/:provider/link-code` (409 while the chat app is off), `DELETE /me/chat-apps/:provider`; `POST /chat-apps/:provider/events` (public, signature only). A `chatAccount.changed` server event refreshes the person's open pages.
- **Web:** Settings → Chat apps (Admins: credentials per provider, write-only, with where to find them and the events path; Members see a notice) and Settings → Notifications (each person: link with a code shown with its countdown, linked state, unlink, the event checkboxes and Quiet Hours). While a code is shown the page also refreshes every 3 seconds, so the link appears even without the event stream.
- **Left open:** bot replies are English only (0058 adds Thai); several server processes would need the attempt limiter and the seen events in a shared store; the events address is shown as a path, since the web doesn't know the API's public URL; no "test connection" for chat apps; LINE group chats, Slack channels and Teams channels are ignored rather than answered.
