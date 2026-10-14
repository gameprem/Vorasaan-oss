---
status: done
depends-on: [0041]
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
- [x] A PO deletes a Feature: its rows and stored files are gone, and the other Features' files stay.
- [x] A non-PO Member gets 403 and nothing changes.
- [x] An Admin deletes a Project: every Feature and Project file under it is removed.
- [x] Receipts and their outcomes survive both deletes; an accepted Feature Suggestion keeps its record without its Feature.
- [x] Outside the caller's Organization both deletes are a 404, as for an unknown id, and change nothing.
- [x] People with open Inbox Items get `inbox.changed`; everyone in the Organization with a stream open gets `feature.deleted` or `project.deleted`.
- [x] Background work queued for a Feature (indexing, Design Doc syncs) ends quietly once it is gone.
- [x] Web (Playwright): a PO deletes a Feature by typing its name, keyboard only for a Project, axe-clean in light and dark; a page someone else has open on it moves away and says why.

## Decisions
- **API.** `DELETE /features/:id` (204) for the Feature's PO Role Owners and Admins of its Organization; a Team PO who is not its Role Owner, or any other Role Owner, gets 403. `DELETE /projects/:id` (204) for Admins only (`@AdminOnly`, then an Admin of *its* Organization). Outside the caller's Organization both are a 404 identical to an unknown id (`organization-scope.ts`), and are in the Organization-scope test's route list. The service is `DeletionService` (`apps/server/src/org/deletion.service.ts`).
- **What goes, what stays.** The schema already cascades everything under a Feature or a Project; no foreign key blocks it (the only RESTRICT keys point at `User`). Checked against the live constraints, nothing needed a migration.

  | Deleted with a Feature (cascade) | Deleted with a Project (cascade, on top) | Kept |
  | --- | --- | --- |
  | Role Owners, target Platforms, Spec Versions, Spec Proposals and their Redrafts, Decision Requests with Recipients, Choices, Decisions, messages, contexts, history, Decider changes, their Redrafts and Chat Cards, Notifications, Design Docs with versions, proposals and Redrafts, its Conversations with messages, Compactions and Action Cards, Attachments, content chunks | Teams (with memberships and Delegations), every Feature, Platforms, Project Brief (versions, proposals), Grillings, Feature Suggestions, Guidelines overrides, Design Doc templates, Project Conversations, Agent Skill enablements, Project Attachments and chunks | Receipts and their outcomes and Skill links (plain ids; the AI usage dashboard already shows "A deleted Project"), Prompt Versions, analyses and Eval Runs (a Replay leaves out a Receipt whose records are gone), Agent Skills and their files (Organization-level), an accepted Feature Suggestion when only its Feature goes (`featureId` set null, the web says the Feature was deleted since) |

  The Decision Log and the request history go with the Feature: they are the Feature's own record, and a Decision with no Feature has nothing to belong to. The AI's work on it stays countable through its Receipts.
- **Plain ids tidied in the transaction:** Chat Cards that link to one of its Spec Proposals by `specProposalId` (a Decision Request's own cards cascade). Action Cards name their target by a plain id, but a Feature's Decision Request and Spec Proposal cards only live in its own Conversations, which cascade.
- **Stored files.** Both deletes go through `AttachmentFilesService.deleteFeature` / `deleteProject`, which now take a `within` callback run in the same transaction (who to tell, the tidy-up) and lock the Feature (or the Project and its Features) with `FOR UPDATE` before listing the files, so an Attachment added meanwhile waits and then fails on its foreign key instead of leaving a file the listing missed. Files are deleted through `FileStorage` only after the commit; one that fails is logged and left for the orphan sweep (0041).
- **Live views.** After the commit: `inbox.changed` to everyone whose Inbox or unread Notifications may have changed (the Team, Role Owners, the people on open Decision Requests and pending Spec Proposals, unread Notifications' owners; for a Project also its Team members and pending Brief Proposal approvers), then a new `feature.deleted` `{ featureId, projectId, title }` or `project.deleted` `{ projectId, name, teamIds, featureIds }` event to every member of the Organization. The web's LiveUpdates moves a page that showed it (a Feature's pages by path, a Team or Project page, and a Decision Request or Conversation page through `<DeletionWatch>`) to the Project (or `/projects`), with a toast and the message in the shell's always-present polite live region; any other page refreshes.
- **Background work.** Indexing, Design Doc syncs and drafts, Redrafts, chat card sending and the escalation job all read their record when they run and already end quietly (or log) when it is gone; a test queues indexing and a Design Doc sync and then deletes. A Conversation reply streaming at that moment fails its write and its page moves away.
- **Web.** "Delete Feature" in the Feature header for those who may (as who may edit the Spec), "Delete Project" in the Project header for Admins. The kit `Dialog` as an `alertdialog`; the name field is focused and labelled, the name is shown as its description, and Delete is enabled only by the exact name (trimmed); Enter deletes, Escape cancels. An error shows in a live region always rendered in the dialog. After deleting it goes to the Feature's Project, or to `/projects`, and says so in the shell's live region. The CLI has no delete.
- **E2E.** `delete-feature-project.e2e.ts` creates its own Feature and Project and deletes only those.
