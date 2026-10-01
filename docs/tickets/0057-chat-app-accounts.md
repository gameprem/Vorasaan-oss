---
status: todo
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
- [ ] A valid code links the account. An expired, reused or wrong code doesn't.
- [ ] A callback with a bad or missing signature is rejected for each of the three providers.
- [ ] Credentials never appear in API responses or logs.
