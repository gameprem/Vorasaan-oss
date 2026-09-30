---
status: todo
depends-on: [0016]
slice: mvp-backend
---

# 0018: Delegations

## Goal
Someone going on leave names a Delegate for a Team and Team Role over a date range, and Decision Requests reach the Delegate instead (REQUIREMENT §3.4).

## Scope
- `GET/POST/DELETE /teams/:id/delegations`. You create your own; an Org Admin can create one for anyone.
- The Delegate must hold the same Team Role in that Team and must not be the delegator. `endsAt` after `startsAt`.
- At submit (0016), a recipient with an active Delegation for `deciderRole` in that Team is replaced by their Delegate (no chains: one hop only). If the Delegate would be the Raiser, keep the original recipient.
- A Decision made by a Delegate records `onBehalfOfId` = the delegator. The view and Decision Log show "decided by C on behalf of A".

## Acceptance criteria (test first, real Postgres)
- [ ] An active Delegation reroutes a single-recipient request to the Delegate; an expired or future one does not.
- [ ] A Delegate without the Team Role is rejected (422). A Member can't create one for someone else (403); an Admin can.
- [ ] The Decision records `onBehalfOfId`.
