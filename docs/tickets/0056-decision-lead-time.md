---
status: todo
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
- [ ] Lead time excludes the time the request spent waiting for the Raiser's answer in NEEDS_INFO.
- [ ] The time waited is attributed to the person who held the request: the routed Recipient, or whoever Claimed it.
- [ ] Browser-verified: the panel shows the median and the overdue count for seeded requests.
