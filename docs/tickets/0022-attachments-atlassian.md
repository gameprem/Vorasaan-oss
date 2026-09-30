---
status: done
depends-on: [0021]
slice: mvp-backend
---

# 0022: Attachments from Confluence and Jira

## Goal
Confluence pages and Jira issues can be attached and snapshotted, read-only.

## Scope
- Admin settings: an `ATLASSIAN` `OrgIntegration` (site URL, email, API token; the token encrypted with `VORASAAN_SECRET_KEY`), with a "test connection" endpoint.
- Attach by Confluence page URL or Jira issue key/URL; the Snapshot is the page body or issue summary + description as text.
- Refresh re-fetches. No write-back.
- A Feature's optional `jiraIssueKey` (Epic) can be set and is shown as a link.

## Acceptance criteria (test first against a fake Atlassian HTTP server)
- [x] Confluence page and Jira issue Attachments snapshot the expected text.
- [x] Without the integration, attaching Atlassian sources returns a clear 422.
- [x] The API token is never returned by any endpoint.
