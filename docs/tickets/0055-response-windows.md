---
status: todo
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
- [ ] A Blocker sent Friday at 16:00, with working hours 09–18 Monday to Friday, is due Monday at 11:00. A holiday on Monday moves it to Tuesday at 11:00.
- [ ] NEEDS_INFO pauses the clock. The time spent waiting for the Raiser's answer doesn't count.
- [ ] Overdue requests escalate in order: reminder, then Delegate, then Raiser and Tech Leads. Running the job twice doesn't repeat a step.
- [ ] Escalation never changes the Decider or the state. A decided request stops escalating.
