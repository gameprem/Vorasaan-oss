---
status: todo
depends-on: [0018]
slice: mvp-web
---

# 0027: Web: Delegation settings

## Goal
People set their own Delegations, and Admins set them for others.

## Scope
- Settings → Delegations: my Delegations (Team, Team Role, Delegate, dates), create and delete. The Delegate picker lists only people with that Team Role in that Team.
- Team page (Admins): Delegations for everyone in the Team.
- A banner on the Inbox when someone is currently delegating to me.

## Acceptance criteria
- [ ] Browser-verified: create a Delegation, raise a request to the delegator, and it appears in the Delegate's Inbox.
