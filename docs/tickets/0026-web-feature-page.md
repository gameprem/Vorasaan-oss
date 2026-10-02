---
status: done
depends-on: [0020, 0021, 0023]
slice: mvp-web
---

# 0026: Web: Feature page with editor, history, diff, Attachments

## Goal
The Feature page is the single overview of REQUIREMENT §3.2.

## Scope
- BlockNote Spec editor that loads and saves Markdown (ADR 0002), for PO Role Owners; others read rendered Markdown.
- Version History: version, source, approver, summary and date. Diff any version against the previous one; PO can revert.
- Decision Log tab (exists): add "on behalf of".
- Attachments panel: upload, add URL/Confluence/Jira, refresh, delete, view Snapshot.
- "Draft Spec from Attachments" for POs → opens the proposal review.
- Blocked badge while any Blocker is open; open Questions don't count. The same badge in Feature lists.

## Acceptance criteria
- [x] Browser-verified: edit in BlockNote → v2 saved as Markdown that round-trips; diff v1↔v2; revert to v1 creates v3.
- [x] Browser-verified: upload a Markdown file, draft a Spec from it, approve.

## Notes
- The editor uses `@blocknote/ariakit` (the lightest UI package: no Mantine, no Tailwind setup) and is loaded client-only.
- Markdown round-trip: headings, bold/italic/code/strike, links, bullet, numbered and nested lists, checklists, quotes, fenced code with a language and GFM tables all survive. The first save of hand-written Markdown reformats it (`-` bullets become `*`, a blank line after headings, padded table cells); after that, re-opening and saving is a no-op. Colors, underline and alignment are not kept (ADR 0002). Trailing spaces are dropped on save so an unchanged Spec never creates a new version.
- Server: `openBlockers` (OPEN or NEEDS_INFO Blockers) on `FeatureView` and on each Feature of `TeamView`, for the Blocked badge.
- Uploads and downloads go through same-origin route handlers (`/api/features/[id]/attachments`, `/api/attachments/[id]/file`) that add the session's Bearer token on the server; uploads are streamed and capped at `ATTACHMENT_MAX_BYTES`.
- A Spec Proposal that did not come from a Decision is reviewed at `/features/[id]/proposals/[proposalId]` (the Inbox links there).
