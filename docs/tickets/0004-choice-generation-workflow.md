---
status: done
depends-on: [0001, 0003]
slice: tracer-bullet
---

# 0004: LLM port and the Choice generation workflow

## Goal
Given a Feature's current Spec and a Decision Request, get 2–4 well-formed Choices and a suggested decider role from the LLM, behind an interface that tests can fake.

## Scope
- **`AiPort` interface** in the server with two methods, both returning Zod-validated data:
  - `generateChoices({ specMarkdown, request }) → { suggestedRole, choices: ChoiceDraft[] }`
  - `draftSpecProposal({ specMarkdown, request, decision }) → { proposedMarkdown, summary }` (used by 0006)
- **Mastra implementation** in `MastraModule` (ADR 0003):
  - Anthropic provider, model `claude-opus-5-5` by default. The model is set per workflow in config.
  - Structured output validated against the shared Zod schemas. On invalid output, retry once, then fail with a clear error.
  - Read the API key from `ANTHROPIC_API_KEY` for now. `OrgIntegration` comes in the MVP.
- **Prompts** in `packages/skills/`, as Markdown files loaded at runtime: `generate-choices.md` and `draft-spec-proposal.md`. The Choice prompt must ask for concrete, mutually exclusive options with impact on scope, time and risk, in the language of the request.
- **`FakeAiPort`** for tests: returns deterministic Choices, and a Spec Proposal that appends a "Decisions" section.
- A small **eval script**, `bun run eval:choices`, that runs 3–5 sample requests against the real model and prints the results for a human to judge. It is not part of `bun run test`.

## Acceptance criteria
- [x] Tests for the Mastra adapter's parsing and retry logic use a stubbed model response, with no network.
- [ ] `bun run eval:choices` with a real key prints 2–4 sensible Choices per sample. **Not yet run: no API key was available during implementation.**
- [x] Changing the model is a config change, not a code change.

## Notes
- Whether Mastra runs these as workflows or plain agent calls is up to you. We don't need suspend/resume yet, because the human-wait state lives in `DecisionRequest.status`.
