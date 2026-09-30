---
status: done
depends-on: [0002, 0003, 0004]
slice: tracer-bullet
---

# 0005: Raise and submit a Decision Request

## Goal
A Role Owner can raise a Decision Request on a Feature, get AI-drafted Choices back as a `DRAFT`, and submit it to a Decider.

## Scope
- Validate request bodies with the shared Zod schemas via NestJS 12 Standard Schema support.
- `GET /features`: the Features where the current user is a Role Owner (used by the CLI picker).
- `POST /decision-requests` (`RaiseDecisionRequestInput`):
  - The Raiser must be a Role Owner of the Feature (403 otherwise).
  - Calls `AiPort.generateChoices` with the latest Spec Version (when `withChoices` is true), then stores the request as `DRAFT` with its Choices and `suggestedRole`.
  - Returns a `DecisionRequestView`.
- `POST /decision-requests/:id/submit` (`SubmitDecisionRequestInput`):
  - Only the Raiser can submit, and only from `DRAFT`.
  - Replaces the Choices if edited ones are sent (marking them `editedByUser`).
  - **Tracer routing rule:** the Decider is the single Role Owner of `deciderRole` on the Feature. If there are zero or several, return 422 (recipient selection and Claim come in the MVP). The Decider must not be the Raiser.
  - Moves to `OPEN` and sets `submittedAt`.
- `GET /decision-requests?decider=me&status=OPEN`: the Inbox query for the web page.
- `POST /decision-requests/:id/withdraw`: Raiser only, from `DRAFT` or `OPEN`, to `WITHDRAWN`.

## Acceptance criteria (test first, against real Postgres + `FakeAiPort`)
- [x] Raise → `DRAFT` with 2–4 Choices and a `suggestedRole`.
- [x] A non-Role Owner can't raise (403).
- [x] Submit → `OPEN` with Pim as Decider. Submitting twice, or by someone other than the Raiser, fails.
- [x] Choices edited at submit are saved and flagged.
- [x] A Decider who would be the Raiser, or an ambiguous Decider, → 422.
- [x] Withdraw works from `DRAFT`/`OPEN` and is rejected afterwards.
- [x] State transitions live in one place (a small state machine module) with its own unit tests.
