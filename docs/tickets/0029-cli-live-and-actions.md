---
status: done
depends-on: [0028, 0024]
slice: mvp-cli
---

# 0029: CLI: live updates, OS notifications and acting from the TUI

## Goal
A Dev never has to leave the terminal: the TUI updates live, pops OS notifications, and supports every action the web has.

## Scope
- SSE client on `GET /events` with reconnect and backoff; the tabs refresh on events.
- OS desktop notifications for new Inbox Items and Notifications (macOS, Linux, Windows; silently skipped when unavailable).
- Actions in the TUI: pick a Choice or answer in my own words, Claim, reassign, ask for info, answer, withdraw, approve or reject a Spec Proposal (with a diff view).
- `bun build --compile` produces a single binary; document it.

## Acceptance criteria
- [x] Tests for the SSE client's reconnect and for each action's API call.
- [x] Manually verified: a Decision made on the web shows up live in the TUI with an OS notification.
