---
status: todo
depends-on: [0050, 0051, 0065]
slice: design-docs
---

# 0069: Design Docs per Platform

## Goal
Each target Platform of a Feature gets an approved Design Doc, drafted by the AI from the approved Spec, so every team builds from the same settled "what" (ADR 0014).

## Scope
- **When:** once a Feature's Spec is approved and a target Platform's Coverage is complete (0051), the AI drafts that Platform's Design Doc. The QA Design Doc is drafted once every target Platform is covered.
- **What, per template:**
  - **Back-End:** API contract, data model, sequences, error cases.
  - **Front-End:** screens and states, API calls, validation.
  - **Mobile:** as Front-End, plus offline and push.
  - **QA:** a test plan and test cases, each traced to an acceptance criterion in the Spec.

  These are built-in templates; a Project can edit them. A Platform added later (for example Flutter) starts from the template it names.
- **Approval:** a Tech Lead or a Role Owner of the Platform's Team Roles approves, declines or requests changes (0065). Others get a 403.
- **Versions:** approved Design Docs are Markdown (ADR 0002), versioned with diffs and revert like Specs (0020), each version naming the Spec Version it follows.
- **The Spec stays the source of truth:** when a new Spec Version changes what a Design Doc covers, that Design Doc is marked stale and the AI proposes an update. A Design Doc never changes the Spec.
- **Questions:** a question found while designing is raised as a Decision Request on the Feature.
- **Elsewhere:** `vorasaan run` hands over the approved Design Doc of the developer's Platform, and the Decision Graph (0067) shows Design Docs as a sub-lane. The AI can use the Project's enabled Agent Skills (0078) while drafting, for example for a diagram.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] No draft while the Spec has a Spec Proposal awaiting approval or the Platform's Coverage is missing; a draft once both hold.
- [ ] Approve creates version 1; Request changes produces a Redraft; a later approved change shows a diff.
- [ ] A new Spec Version that changes the Back-End section marks the Back-End Design Doc stale, not the Front-End one, and the AI proposes an update.
- [ ] Only the Platform's Tech Lead or Role Owners can approve; others get a 403.
- [ ] A question the AI finds while drafting becomes a Decision Request.
