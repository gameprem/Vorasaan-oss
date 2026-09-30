---
status: done
depends-on: []
slice: tracer-bullet
---

# 0003: Shared contracts for Decision Requests and Specs

## Goal
Zod schemas in `packages/shared` for everything the tracer bullet sends over the wire. They are the only API contract (ADR 0004).

## Scope
Replace the outdated `RoleEnum` / `BlockerPayload` in `packages/shared/src/index.ts` with:
- Enums mirroring Prisma: `TeamRole` (including `TECH_LEAD`), `DecisionRequestKind`, `DecisionRequestStatus`, `ProposalStatus`, `SpecVersionSource`.
- `ChoiceDraft`: `label`, `title`, `description`, `impactScope`, `impactTime`, `impactRisk`.
- `RaiseDecisionRequestInput`: `featureId`, `kind`, `title`, `description`, optional `withChoices` (default true).
- `SubmitDecisionRequestInput`: `deciderRole`, optional edited `choices` (2–4 items).
- `DecideInput`: exactly one of `choiceId` or `customAnswer`, plus optional `rationale`.
- Views returned by the API: `DecisionRequestView` (with `choices`, `decision`), `SpecProposalView` (with `baseMarkdown` and `proposedMarkdown`), `SpecVersionView`, `DecisionLogEntry`.
- Export inferred TypeScript types for each.

## Acceptance criteria
- [x] Unit tests (`bun test`): valid samples parse, and invalid ones fail. Cover 1 or 5 choices, `DecideInput` with both or neither of choice/answer, and an unknown enum value.
- [x] A test asserts the enum values match the Prisma-generated enums, so they can't drift.
- [x] No `Blocker*`, `assignee` or other _Avoid_ terms from `CONTEXT.md` remain.
