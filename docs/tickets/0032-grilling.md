---
status: done
depends-on: [0030, 0031]
slice: project-foundation
---

# 0032: Grilling a Project into a Brief

## Goal
The AI asks the right people the right questions and turns the answers into a Brief Proposal a PO approves. This works for a new Project and for an existing one (REQUIREMENT §3.8).

## Scope
- A Mastra workflow (ADR 0003) with suspend/resume between rounds:
  1. **Read what exists:** the current Brief, Project Attachments, existing Features and their latest Specs, and the latest Repo Scan (0033) if any.
  2. **Ask, in rounds:** business (PO), then UX (Designer), then technical (Tech Lead). Each round has 3–7 questions and only covers what the known material doesn't answer. Questions go to the people holding that Team Role in the Project's Teams, and any of them can answer.
  3. **Draft:** a Brief Proposal (`source: GRILLING`) for the starting PO to approve.
- API:
  - start a Grilling (the Project's POs and Admins), get its state and questions, answer a question, skip a round, cancel;
  - `GET /grillings?awaiting=me` for people with questions waiting.
- `AiPort` methods with prompts in `packages/skills` (Grilling questions; Brief drafting). `FakeAiPort` covers them, and eval cases are added.
- One active Grilling per Project at a time.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [x] New Project: start → three rounds answered by the PO, Designer and Tech Lead → a proposal → approve → Brief v1 with `source: GRILLING`.
- [x] Existing Project with Features and an Attachment: the AI input contains them, and the rounds ask fewer questions.
- [x] Only people with the round's Team Role can answer. Cancelling writes no Brief Version.

## Decisions
- **No Mastra workflow snapshots.** Mastra has no snapshot storage configured (it is used as a library for single calls, ADR 0003), and a Grilling spans days and many people, so its state lives in Prisma tables it owns: `Grilling` (status RUNNING, DRAFTED or CANCELLED, current round, `memory` with the round summaries, `revision`, the Brief Proposal), `GrillingRound` (BUSINESS, UX, TECHNICAL with its Team Role; ASKING, ANSWERED or SKIPPED with a reason) and `GrillingQuestion`. Each step is one AI call plus a transaction, so suspend/resume would add storage and a second source of truth without saving anything. Migration `20261001130000_grilling` also adds the partial unique indexes "one RUNNING Grilling per Project" and "one ASKING round per Grilling", a check that each round has its Team Role, and `BriefProposal.summary` (copied into the Brief Version on approval).
- **Rounds and who answers:** BUSINESS → PO, UX → DESIGNER, TECHNICAL → TECH_LEAD, in any of the Project's Teams, checked live on every answer (an Admin who holds none of them doesn't answer). Any holder answers any question once. A round with nobody holding its Team Role is skipped (`NO_ONE_WITH_ROLE`); a round the AI has nothing to ask about is skipped (`NOTHING_TO_ASK`), so the AI returns 0–7 questions (3–7 when it has gaps to ask about). After the last round the Brief Proposal (`source: GRILLING`, approver = the starter) is drafted; a Project with nobody in any of the three Team Roles is drafted at once.
- **Skip and cancel:** the starter (while still a PO of the Project or an Admin) or any Admin. Skipping takes the round's name, so a stale view can't skip the next one; its answers still count. Cancelling works while RUNNING, and while DRAFTED with a pending proposal (the proposal is then rejected), so no Brief Version ever comes of it.
- **No partial writes:** every move (start, the answer that completes a round, a skip) makes its AI calls first, then writes in one transaction under a row lock and a `revision` check. Any AI failure is a 502 and the Grilling stays as it was (the completing answer isn't saved either). Concurrent answers to one round are serialized by the lock; the one that completes the round moves it on once.
- **AI input:** `ContextRetriever.forProject(projectId, query, budget)` (12,000 tokens): the latest Brief Version first, then up to 25 Features with their status, description and the first 800 characters of their latest Spec, then Project Attachment chunks (the Repo Scan is one; only the newest exists), unindexed Project Attachments whole, then Spec and Decision chunks. Feature Attachments and other Projects are never included. Brief drafting gets the whole current Brief (or the template) as its base and the context without the Brief. Round memory uses `workflow-memory.ts`: a short summary (questions and answers) per round, including skipped ones. Answers, Guidelines, memory and the Brief are fenced like retrieved context.
- **API:** `POST /projects/:id/grillings`, `GET /projects/:id/grillings`, `GET /grillings/:id`, `POST /grillings/:id/questions/:questionId/answer`, `POST /grillings/:id/skip-round` (`{ round }`), `POST /grillings/:id/cancel`, `GET /grillings?awaiting=me`. Everyone in the Organization reads a Grilling.
- **Inbox:** Project-level items carry `project` instead of `feature`: `ANSWER_GRILLING` (a round waiting for a Team Role I hold, with the unanswered count) and `APPROVE_BRIEF_PROPOSAL` (any pending Brief Proposal I approve). `inbox.changed` goes, after commit, to the holders of the round that ended and of the one that started, and to the starter when a proposal is drafted or cancelled.
- **Eval:** `bun run eval:grilling` (manual, real model): questions for a new and an existing Project, a later round with memory, Thai, an injection in a context block, and Brief drafts with an injected answer. Not yet run against a real model.
