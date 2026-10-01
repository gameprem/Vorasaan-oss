---
status: todo
depends-on: [0042]
slice: chat-web-ui
---

# 0043: Action Cards: the AI proposes from a Conversation

## Goal
From a Conversation the AI can draft the things the forms create today. Nothing takes effect until a person approves the Action Card (ADR 0008).

## Scope
- Tools available to the AI. Each one only drafts or reads, with the caller's permissions:
  - `draftDecisionRequest`: creates a DRAFT Decision Request with AI Choices. It is the same draft the raise form makes, and the user reviews it and sends it.
  - `draftSpecProposal`: available on a Feature.
  - `draftBriefProposal`: available on a Project.
  - `suggestFeatures`.
  - `searchContext`: retrieval within the Conversation's scope.
- `ActionCard` (kind, target id, status PROPOSED, APPROVED, DECLINED or STALE) is linked to the message that made it.
- Approve and decline call the existing services: send the draft, approve the Spec Proposal or Brief Proposal, accept the Feature Suggestion. Permissions, the state machine and the Inbox are not reimplemented.
- A card whose target changed elsewhere (for example a proposal approved in another tab) shows as STALE.

## Acceptance criteria (test first, real Postgres + `FakeAiPort`)
- [ ] The fake AI calls `draftSpecProposal` → a Spec Proposal exists, but no Spec Version → approving the card writes the Spec Version through the existing service.
- [ ] A tool call for something the user may not do (for example a Spec Proposal on a Feature where they are not the PO) is refused, and the AI is told why.
- [ ] An injected instruction in an Attachment that asks the AI to approve something produces at most a PROPOSED card. Nothing is approved.
