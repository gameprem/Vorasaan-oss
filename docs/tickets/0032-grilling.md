---
status: todo
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
- [ ] New Project: start → three rounds answered by the PO, Designer and Tech Lead → a proposal → approve → Brief v1 with `source: GRILLING`.
- [ ] Existing Project with Features and an Attachment: the AI input contains them, and the rounds ask fewer questions.
- [ ] Only people with the round's Team Role can answer. Cancelling writes no Brief Version.
