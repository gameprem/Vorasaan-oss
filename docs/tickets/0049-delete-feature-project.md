---
status: todo
depends-on: []
slice: backlog
---

# 0049: Delete a Feature or a Project

## Goal
A PO can delete a Feature, and an Admin can delete a Project, without leaving stored Attachment files behind (follow-up from 0041).

## Scope
- `DELETE /features/:id` for the Feature's POs and Admins, and `DELETE /projects/:id` for Admins.
- Both go through `AttachmentFilesService.deleteFeature` / `deleteProject`, so the files are removed after the database delete commits.
- The web asks for confirmation by having the person type the name. The CLI has no delete.
- People with open Inbox Items for the deleted Feature get an `inbox.changed` event.

## Acceptance criteria (test first, real Postgres)
- [ ] A PO deletes a Feature: its rows and stored files are gone, and the other Features' files stay.
- [ ] A non-PO Member gets 403 and nothing changes.
- [ ] An Admin deletes a Project: every Feature and Project file under it is removed.
