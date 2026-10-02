---
status: done
depends-on: [0055]
slice: decision-speed
---

# 0056: Decision Lead Time

## Goal
A team can see how fast it decides and where requests wait (ADR 0011).

## Scope
- Record each Decision Request's sent, claimed, NEEDS_INFO (asked and answered), escalated and decided times, from its existing history.
- API: `GET /projects/:id/decision-stats?from&to` returns:
  - the median and 90th-percentile Decision Lead Time, split by kind;
  - the overdue count;
  - the time waited per person and per Team Role.
- Web:
  - a small panel on the Project page: median lead time, overdue now, a weekly trend sparkline;
  - a list of overdue requests.
  - It moves into the chat shell with 0045.

## Acceptance criteria (test first, real Postgres, fake clock)
- [x] Lead time excludes the time the request spent waiting for the Raiser's answer in NEEDS_INFO.
- [x] The time waited is attributed to the person who held the request: the routed Recipient, or whoever Claimed it.
- [x] Browser-verified: the panel shows the median and the overdue count for seeded requests.

## Decisions
- **Working Time, not wall-clock.** Decision Lead Time counts the Organization's Working Time (its time zone, working days and hours, minus holidays), like Response Windows, so a Blocker sent Friday at 17:00 and decided Monday at 10:00 took 2 hours, not 65. It leaves out every NEEDS_INFO spell, from the Decider's QUESTION to the Raiser's ANSWER: then the request waits on the Raiser, not on anyone who decides. The API reports working minutes; the web shows "45m", "2h 30m", "26h" (never days, since a working day is not 24 hours).
- **Rebuilt from the request's rows** (`apps/server/src/decision-stats/`): sent is `submittedAt`; the Recipients are the `RequestRecipient` rows, a Delegate added by escalation step 2 counting from that step's `DELEGATES_ADDED` history entry (its `people`); NEEDS_INFO asked and answered are the QUESTION and ANSWER `RequestMessage`s (a note changes nothing); escalated is the `RequestHistoryEntry` of each step; decided is the `Decision`'s `createdAt`, withdrawn is `closedAt`. The message, Decision and `closedAt` times now come from the injected clock (they were the database's `now()`, and `closedAt` the server's), so tests can place them.
- **One new table, `DeciderChange`** (`CLAIMED` or `REASSIGNED`, the new Decider, when), written by every Claim (explicit, or implied by a Recipient asking a QUESTION or deciding) and by every reassign. When the Decider changed was not recoverable: `deciderId` keeps only the last one, reassigning wrote nothing, and the `REQUEST_CLAIMED` Notifications don't record who Claimed nor survive their recipient. A table rather than more `RequestHistoryKind`s, because history entries are unique per request and kind (escalation relies on it) while a request can be Claimed or reassigned many times. Requests Claimed before this migration have no rows; their wait stays with their Recipients.
- **Who held the request.** From sent until the first `DeciderChange`, every Recipient at that moment holds it (a request sent to one person: that person); from then on, whoever the latest change names. A request held by several Recipients counts its full wait for each of them, and once for its Team Role (its decider role).
- **API** (Zod in `packages/shared/src/decision-stats.ts`): `GET /projects/:id/decision-stats?from&to`, for every member of the Project's Organization (`projectAccess`: 404 for an unknown Project, 403 outside the Organization), as the Brief is. `to` defaults to now, `from` to 12 weeks before `to`; at most 366 days. It returns `leadTime.all` and `leadTime.byKind.{BLOCKER,QUESTION}` as `{ decided, medianMinutes, p90Minutes }` over the requests decided in `[from, to)` (percentiles interpolate between the closest ranks; null when nothing was decided); `weekly`, 7-day buckets ending at `to` with each one's count and median; `overdue` (`count` and the requests, most overdue first: OPEN with `dueAt` passed, whatever the range; one in NEEDS_INFO is paused, so not overdue), each with who it waits on and its `responseWindow` state; and `waited.byPerson` / `waited.byRole`, the working minutes each held the Project's requests within the range (open ones up to now) and how many requests, longest first.
- **Web:** a "Decision speed" panel on the Project page, above its tabs (the Project page is where a Project's overview lives in the chat shell: the Sidebar and the chat header link to it): the median lead time with its count and per-kind medians, "Overdue now" with the Team Role waited on longest, an inline SVG sparkline of the weekly median (design tokens, one series, a tooltip per week, an `aria-label` listing the values), and the overdue requests with their kind, labels ("overdue 3h", "escalated") and who they wait on.
- **Left open:** no per-Team or per-Feature breakdown and no range picker in the web (the API takes `from` and `to`); the per-person and per-role waits are in the API but not shown beyond the top role; a change to the calendar recomputes past lead times in the new calendar.
