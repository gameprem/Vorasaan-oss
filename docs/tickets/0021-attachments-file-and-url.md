---
status: done
depends-on: []
slice: mvp-backend
---

# 0021: Attachments: files and URLs, with Snapshots

## Goal
A Feature collects its documents, and their content is captured as a Snapshot the AI can use (REQUIREMENT §3.2 Attachments).

## Scope
- `FileStorage` interface with a local-disk driver (default, a Docker volume path) and an S3-compatible driver (`FILE_STORAGE_DRIVER=s3`, `S3_*` env vars). Nothing else touches `fs` for Attachments.
- `POST /features/:id/attachments` (multipart file: md, txt, pdf, images; or a public URL), `GET` list, `GET /attachments/:id/file`, `DELETE`.
- Snapshot on create:
  - md and txt as-is;
  - pdf → text;
  - URL → readable text from the HTML;
  - images: no text (title only).
  Cap the Snapshot size.
- `POST /attachments/:id/refresh` re-fetches URLs and re-reads files; updates `snapshotAt`.
- Any Role Owner of the Feature (or Admin) can add or remove; everyone in the Organization can read.
- Update `.env.example` and the Docker volume.

## Acceptance criteria (test first, real Postgres; the S3 driver is tested against a fake)
- [x] Upload a Markdown file → Snapshot equals its text; download returns the same bytes.
- [x] A URL Attachment snapshots readable text from a local test HTTP server; refresh picks up a change.
- [x] Oversized files and disallowed types are rejected.
