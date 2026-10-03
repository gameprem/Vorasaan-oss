---
status: done
depends-on: [0011, 0055, 0062]
slice: install-and-onboarding
---

# 0063: Setup asks for the calendar and language, then a Getting started checklist

## Goal
A new Organization starts with the right time zone, working days and hours, and language, so Response Windows and chat app cards are right from the first Decision Request. After setup, a Getting started checklist leads the first Admin to a working team, and ticks itself as things get done.

## Scope
- **Setup step "Calendar & language"** in the `/setup` wizard, between "Your organization" and "AI provider":
  - Time zone, prefilled from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`, e.g. `Asia/Bangkok`), changeable from the IANA list.
  - Working days (Mon to Fri by default) and working hours (e.g. 09:00 to 18:00), the ones Response Windows count in (ADR 0011).
  - Language (English or Thai), the Organization's default for the web app and chat app cards.
  - `SetupInput` gains these fields (Zod); `POST /setup` writes the time zone, working days and hours to the Organization's working calendar (`ResponseWindowSettings`, today defaulting to UTC, Monday to Friday 09:00-18:00) in the same transaction, keeping the default Response Windows. The language needs an Organization-level default (today only chat app accounts have one). Admins change all of it later in Settings.
- **Getting started checklist** after setup (on the Inbox, dismissible by the Admin, gone once complete):
  1. Create a Project and a Team.
  2. Create a Feature and write its Spec.
  3. Invite members.
  4. Link the CLI (`vorasaan login`).
  5. Optionally, connect a chat app (LINE, Slack or Teams).
- Each item ticks itself from what exists (a Project with a Team, a Feature with a Spec Version, an accepted invitation, a Personal Access Token in use, a configured chat app); nothing is ticked by hand. Each item links to where it's done.

## Acceptance criteria (test first)
- [x] Setup stores the time zone, working days and hours, and language; a missing or invalid time zone is a `400`.
- [x] The wizard prefills the browser's time zone (unit test of the prefill with a mocked `Intl`, and the e2e runs the browser in `Asia/Bangkok`).
- [x] A Response Window started right after setup counts in the Organization's working hours (server test).
- [x] `GET` for the checklist returns each item's state from the database; doing each thing ticks it (API test).
- [x] The checklist disappears once complete or dismissed; Members never see it.
- [x] e2e: run setup from an empty database, see the checklist, create a Project and Team, and watch the first item tick.

## Decisions
- **Contract.** `SetupInput` gains `workingTime` (`WorkingTimeInput`: time zone, working days, start and end) and `language` (`en` or `th`), both optional so an older client still works; left out, the Organization keeps the defaults (UTC, Monday to Friday 09:00-18:00, English). Given, `workingTime` needs every field, so a missing time zone there is a `400`, as is one `Intl` doesn't know. `WorkingTimeInput` shares its fields and checks with `ResponseWindowSettingsInput`.
- **Calendar.** Setup writes the `ResponseWindowSettings` row (ticket 0055) in the Organization's transaction, with the default windows (Blocker 4 working hours, Question 2 working days). No second calendar. The wizard's fields are the Settings → Response Windows ones (`WorkingTimeFields`).
- **Language on the Organization.** `Organization.language` (`en` default), not on `ResponseWindowSettings`, which is the working calendar. Every member reads it (`GET /settings/organization`); Admins change it in the new **Settings → Organization** section (`PUT /settings/organization`). It is the fallback wherever a person has no language of their own: their chat cards and bot replies, and bot replies to a chat account nobody has linked. `ChatPreference.language = null` now means "the Organization's" (was "English"); `ChatPreferencesView` gains `effectiveLanguage`, and Settings → Notifications offers "The Organization's (…)". People who saved a language before keep it.
- **Prefill.** The wizard renders UTC first and switches to the browser's zone after mounting (`browserTimeZone()`, which falls back to UTC for anything that isn't an IANA zone), so the server and browser render the same. It also starts on Thai when the browser's language is Thai.
- **Checklist API.** `GET /me/getting-started` and `POST /me/getting-started/dismiss`, Admins only (`403` for Members, and the web never asks for them). Nothing is stored but the dismissal; each item is counted on every read:
  - *Create a Project and a Team*: the Organization has a Team (a Team always has a Project).
  - *Create a Feature and write its Spec*: some Feature has a Spec Version.
  - *Invite members*: someone besides the first Admin is a member. People only join by accepting an invitation, so this is "an accepted invitation" without depending on the invitation rows.
  - *Link the CLI*: the viewer's own Personal Access Token has been used (`lastUsedAt`), and isn't revoked or expired. Personal, because the CLI is: another person's token doesn't link the Admin's CLI.
  - *Connect a chat app* (optional): LINE, Slack or Teams is turned on. Complete means every other item is done.
- **Dismissal** is per Admin (`OrgMembership.gettingStartedDismissedAt`), so a second Admin still sees the checklist. It is permanent; the Settings sections stay where they are.
- **Where.** On the Inbox (the home page, and where setup lands), above everything, replacing the old "Vorasaan is ready" notice. Each open item links to where it is done: Projects, the first Team (or Projects before there is one), Settings → Members, Settings → Access tokens, Settings → Chat apps. Members see nothing: no smaller member version, since their next steps arrive as Inbox Items anyway.
- **e2e.** `setup.e2e.ts` starts its own server and web app on a database of its own (`…_setup_e2e`, created, migrated and emptied by `e2e/fresh-db.ts`), because every other spec shares the seeded one. `getting-started.e2e.ts` runs on the seeded Organization (only the CLI step is open there).

## Left open
- The web app's own language still follows the browser (`Accept-Language`, ticket 0046); the Organization's language only covers chat app cards and bot replies.
- Grilling texts and the AI's replies are not affected by the Organization's language.
