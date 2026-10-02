---
status: done
depends-on: []
slice: decision-speed
---

# 0055: Response Windows and escalation

## Goal
No Decision Request waits silently. When it runs past its Response Window, the right people hear about it, and nobody but a person decides (ADR 0011).

## Scope
- **Organization settings:**
  - time zone, working days, working hours, and a holiday list;
  - default windows: Blocker 4 working hours, Question 2 working days.
  - A Project can override the defaults.
  - The Raiser may shorten the window when sending, never lengthen it.
- **`DecisionRequest`:**
  - `dueAt` is set when the request is sent.
  - While the request is in NEEDS_INFO the clock pauses, and it resumes on the answer.
  - `escalationStep` records how far escalation has gone.
- **Escalation job:**
  - It runs every minute, is idempotent, and takes a row lock per request.
  - Steps:
    1. Remind the Recipients (Notification and `inbox.changed`).
    2. Half a window later, add each Recipient's active Delegate as a Recipient.
    3. Half a window after that, notify the Raiser and the Team's Tech Leads that the request is overdue.
  - Every step goes into the request history.
- **Inbox and lists:** they show "due in 2h", "overdue 1h" and "escalated".
- **CLI:** the TUI Inbox shows the same labels.

## Acceptance criteria (test first, real Postgres, fake clock)
- [x] A Blocker sent Friday at 16:00, with working hours 09–18 Monday to Friday, is due Monday at 11:00. A holiday on Monday moves it to Tuesday at 11:00.
- [x] NEEDS_INFO pauses the clock. The time spent waiting for the Raiser's answer doesn't count.
- [x] Overdue requests escalate in order: reminder, then Delegate, then Raiser and Tech Leads. Running the job twice doesn't repeat a step.
- [x] Escalation never changes the Decider or the state. A decided request stops escalating.

## Decisions
- **Settings and defaults.** `ResponseWindowSettings` (one row per Organization) holds the time zone (IANA name, checked with `Intl`), the working days (ISO weekdays), the working hours (`HH:MM` in the API, minutes after midnight in the database) and the default windows; `OrgHoliday` holds the holiday list (one per date). Without a row the defaults apply: UTC, Monday to Friday 09:00-18:00, no holidays, Blocker 4 working hours, Question 2 working days (`DEFAULT_RESPONSE_WINDOW_SETTINGS` in `packages/shared`). UTC because Vorasaan cannot guess where an Organization works; the Admin sets it.
- **API** (Zod schemas in `packages/shared/src/response-window.ts`): `GET /settings/response-windows` (every member), `PUT /settings/response-windows` (Admins; replaces everything, holidays included); `GET /projects/:id/response-windows` (the Project's own windows and the ones in effect), `PUT /projects/:id/response-windows` (Admins; `null` per kind keeps the Organization's). A window is `{ value, unit: WORKING_HOURS | WORKING_DAYS }`; a working day is one day of working hours, so 2 working days from Tuesday 10:00 is Thursday 10:00. The Project override lives on `Project` (four nullable columns) and only overrides the windows; the calendar is Organization-wide.
- **The Raiser shortens on send.** `SubmitDecisionRequestInput.responseWindow` is optional; one longer than the Project's default for the kind is refused with 422. The web draft review shows the default, prefilled, and sends a window only when it was changed.
- **Working time is a pure module** (`apps/server/src/response-windows/working-time.ts`): `addWorkingTime`, `workingTimeBetween`, `windowLength`, in milliseconds, with time zones from `Intl.DateTimeFormat` (no library; DST follows the IANA data Bun ships). A window that ends exactly at closing time ends then, not at the next opening.
- **On `DecisionRequest`:** `responseWindowMinutes` (the window actually given, in working minutes), `dueAt`, `pausedAt` and `escalationStep` (0 to 3). `dueAt` is set on submit from the injected clock. Asking a QUESTION (NEEDS_INFO) sets `pausedAt`; the Raiser's ANSWER moves `dueAt` later by the working time between `pausedAt` and now, and clears it. Views expose `responseWindow: { dueAt, paused, escalationStep }` on Decision Requests and on DECIDE/CLAIM Inbox Items, and `history` on Decision Requests.
- **Escalation times.** Step 1 at `dueAt`; step 2 half a window (rounded up to a minute) of working time later; step 3 a whole window after `dueAt`. A paused request is never escalated, and its next steps move with `dueAt`.
- **Who each step reaches.** 1: the Decider or, while nobody has Claimed it, every Recipient (`REQUEST_REMINDER` and `inbox.changed`). 2: each Recipient's active Delegate for the decider role (not the Raiser, not someone already a Recipient) becomes a Recipient on the delegator's behalf, gets `REQUEST_ESCALATED` and can Claim it; the step is recorded even when nobody has an active Delegate. 3: the Raiser and the Team's Tech Leads get `REQUEST_OVERDUE`. Each step writes one `RequestHistoryEntry` (`REMINDED`, `DELEGATES_ADDED`, `OVERDUE_REPORTED`; unique per request and kind) with a snapshot of who it reached, shown as "Escalation" on the request page. Notifications from escalation have no actor.
- **The job.** `EscalationJob.run()` finds OPEN requests with `dueAt <= now` and `escalationStep < 3`, then handles each in its own transaction: `SELECT ... FOR UPDATE SKIP LOCKED` on the row, re-read under the lock, take every step now due in order (a run after downtime catches up), and write the new `escalationStep`. It never writes `status` or `deciderId`; a request decided, withdrawn or in NEEDS_INFO is not OPEN and is skipped. `EscalationScheduler` runs it every 60 s in every server process (no overlapping runs in one process); the row locks keep several instances from taking a step twice. `VORASAAN_ESCALATION_JOB=off` turns the timer off, which the test app does: tests call `run()` with the fake clock (`CLOCK` provider, `FakeClock` in `apps/server/src/test`).
- **Labels** come from `responseWindowLabels` in `packages/shared`, used by the web (Inbox, My Requests, the request page) and the CLI TUI (Inbox lines and My Requests): "due in 45m / 2h / 3d" or "overdue ...", plus "escalated" from step 2 (once the Delegates were added). Wall-clock time to `dueAt`, rounded down; nothing while paused, and lists show them only for OPEN requests.
- **Settings UI**: a "Response Windows" section of the Settings modal. Admins edit the calendar, holidays, default windows and each Project's own windows; Members read a summary.
- **Left open:** a Delegation that starts after step 2 doesn't bring its Delegate in (the step has passed); `EventBus` is still in-process, so with several instances `inbox.changed` reaches only clients of the instance that ran the step (unchanged from before, see `event-bus.ts`); changing the calendar does not move the `dueAt` of requests already sent.

