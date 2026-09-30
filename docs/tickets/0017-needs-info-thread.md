---
status: todo
depends-on: [0016]
slice: mvp-backend
---

# 0017: Ask for more info (NEEDS_INFO thread)

## Goal
The Decider can send a question back to the Raiser instead of deciding, and the request returns to `OPEN` when the Raiser answers.

## Scope
- `POST /decision-requests/:id/messages`:
  - Decider, from `OPEN`, `kind: QUESTION` → `NEEDS_INFO`.
  - Raiser, from `NEEDS_INFO`, `kind: ANSWER` → `OPEN` (Decider unchanged).
  - Either party may add a `NOTE` without changing state.
- The thread is returned in the Decision Request view, oldest first.
- The Raiser may withdraw from `NEEDS_INFO`.
- Reuse the state machine in `decision-request.state.ts`; extend its tests first.

## Acceptance criteria (test first, real Postgres)
- [ ] Decider asks → `NEEDS_INFO`; Raiser answers → `OPEN`; the Decider can then decide.
- [ ] Nobody else can post a QUESTION or ANSWER (403); wrong state is 409.
- [ ] Deciding while `NEEDS_INFO` is rejected.
