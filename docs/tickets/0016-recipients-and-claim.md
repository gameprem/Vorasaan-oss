---
status: done
depends-on: []
slice: mvp-backend
---

# 0016: Recipients, Claim and reassign

## Goal
The Raiser sends a Decision Request to one Role Owner or to all of them, and the right person ends up as the Decider (REQUIREMENT §3.3 steps 4–6).

## Scope
- `POST /decision-requests/:id/submit` takes the confirmed `deciderRole` and `recipients: 'ALL' | { userId }`:
  - One Role Owner for the role → selected automatically.
  - No Role Owner for the role → all Team members holding that Team Role.
  - Store `RequestRecipient` rows. The Raiser is never a recipient.
  - Exactly one recipient → they are the Decider. Several → `deciderId` stays null.
- `POST /decision-requests/:id/claim`: anyone holding `deciderRole` in the Feature's Team, only from `OPEN`. Sets the Decider. Claiming a request that already has a Decider is allowed (routed to someone else) and replaces them.
- Deciding directly as a recipient with no Decider implies a Claim.
- `POST /decision-requests/:id/reassign { userId }`: the current Decider only; the target must hold `deciderRole` in the Team and must not be the Raiser.
- `GET /decision-requests?recipient=me` for the "claim or decide" list.
- Zod contracts in `packages/shared`; views expose recipients and whether I can claim.

## Acceptance criteria (test first, real Postgres)
- [x] Single Role Owner → Decider set at submit. `ALL` with two Role Owners → no Decider until one Claims.
- [x] No Role Owner for the role → recipients are the Team members with that role.
- [x] Claim by a non-holder of the role is 403; claim outside `OPEN` is 409.
- [x] A recipient deciding without claiming becomes the Decider.
- [x] Reassign to the Raiser or to someone without the role is rejected.
