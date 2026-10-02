---
status: done
depends-on: [0019]
slice: mvp-web
---

# 0025: Web: Inbox, Notifications and live updates

## Goal
The home page shows every Inbox Item kind and the Notifications, and updates without a reload.

## Scope
- `/inbox`: all Inbox Item kinds (six since 0032; Grilling and Brief items link to `/projects/[id]`, built in 0035) from `GET /inbox`, grouped, each linking to where the action happens.
- Notifications list with unread state, mark read and mark all read; an unread count in the header.
- Subscribe to `GET /events` and refresh the Inbox and Notifications when events arrive.
- A "My Requests" page: Decision Requests I raised and their status.

## Acceptance criteria
- [x] Browser-verified: with two sessions open, a Decision in one makes the Raiser's Notification appear in the other without a reload.
- [x] Each Inbox Item disappears once its action is done.
