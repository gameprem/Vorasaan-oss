---
status: todo
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
- [ ] Setup stores the time zone, working days and hours, and language; a missing or invalid time zone is a `400`.
- [ ] The wizard prefills the browser's time zone (component test with a mocked `Intl`).
- [ ] A Response Window started right after setup counts in the Organization's working hours (server test).
- [ ] `GET` for the checklist returns each item's state from the database; doing each thing ticks it (API test).
- [ ] The checklist disappears once complete or dismissed; Members never see it.
- [ ] e2e: run setup from an empty database, see the checklist, create a Project and Team, and watch the first item tick.
