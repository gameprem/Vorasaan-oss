---
status: done
depends-on: []
slice: mvp-polish
---

# 0041: Hardening follow-ups from the MVP reviews

## Goal
Close the small gaps the MVP reviews recorded.

## Scope
- **Revoked tokens close live streams:** `GET /events` re-checks the session or Personal Access Token on each heartbeat and ends the stream once it is revoked or expired.
- **No orphaned files:** deleting a Feature or Project deletes its Attachment files through `FileStorage` (after the database delete commits), and an Admin endpoint sweeps files whose Attachment no longer exists.
- **TUI polish:** the "retrying in Ns" counter counts down; after a live refresh the cursor stays on the same item (by id), not the same row number; stale ✔ messages clear on refresh.

## Acceptance criteria (test first)
- [x] Revoking a PAT ends its open `/events` stream within one heartbeat (server test).
- [x] Deleting a Feature with a file Attachment removes the file from storage; the sweep removes a planted orphan and leaves live files alone (server test).
- [x] TUI component tests for the countdown and cursor-by-id.
