---
status: done
depends-on: [0017, 0018]
slice: mvp-backend
---

# 0019: Inbox Items, Notifications and the event stream

## Goal
One place tells each person what needs their action (Inbox Items) and what happened (Notifications), live (REQUIREMENT §3.5).

## Scope
- `InboxModule`.
- `GET /inbox`: Inbox Items **derived from state**, never stored:
  - decide an `OPEN` request where I'm the Decider;
  - claim or decide an `OPEN` request with no Decider where I'm a recipient;
  - answer a `NEEDS_INFO` request I raised;
  - approve a `PENDING` Spec Proposal where I'm the approver.
- Notifications are written in the same transaction as the event:
  - `REQUEST_DECIDED` → Raiser;
  - `REQUEST_CLAIMED` → the other recipients;
  - `REQUEST_WITHDRAWN` → Decider or recipients;
  - `SPEC_VERSION_CREATED` → the Feature's PO Role Owners (not the approver);
  - `DELEGATION_STARTED` → the Delegate (when created with `startsAt` ≤ now; otherwise when it starts; checked lazily on read is acceptable).
- `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`.
- `GET /events` (SSE, same auth as the API, PAT for the CLI): pushes `inbox.changed` and `notification.created` for the signed-in user. In-process event bus is enough (one instance per Organization).

## Acceptance criteria (test first, real Postgres)
- [x] Each Inbox Item kind appears and disappears with the state change that ends it.
- [x] Each Notification type is created for the right people and not for the actor.
- [x] An SSE client receives an event after a Decision is made.

## Notes
- `DELEGATION_STARTED` for a Delegation that has already started is written in the create transaction. One that starts later is written lazily, on the Delegate's next `GET /inbox`, `GET /notifications` or `GET /events` heartbeat (~25 s). A new, additive `Notification.delegationId` (unique) links it to its Delegation and keeps it to one.
- `REQUEST_CLAIMED` also reaches the Decider a Claim replaces, and follows an implied Claim (deciding or asking a question without Claiming first).
- `GET /events` uses the API's Bearer auth (session token or PAT). The web will proxy it through a same-origin Next.js route that forwards its httpOnly session cookie as the Bearer header.
- Events are pushed only after the transaction commits. `inbox.changed` carries no data: clients refetch `GET /inbox`.
