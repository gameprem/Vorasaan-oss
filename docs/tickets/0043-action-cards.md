---
status: done
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
- [x] The fake AI calls `draftSpecProposal` → a Spec Proposal exists, but no Spec Version → approving the card writes the Spec Version through the existing service.
- [x] A tool call for something the user may not do (for example a Spec Proposal on a Feature where they are not the PO) is refused, and the AI is told why.
- [x] An injected instruction in an Attachment that asks the AI to approve something produces at most a PROPOSED card. Nothing is approved.

Also tested (`apps/server/src/conversations/action-cards.api.test.ts`): a card goes STALE when its target is approved elsewhere or its Spec moves on; approving twice is refused; only the Conversation's owner acts on its cards (an Admin gets 404); every tool, approve and decline path; the tool-round cap; an AI failure after a tool round, then retry. `apps/server/src/ai/mastra-chat.test.ts` runs the real Mastra adapter against a stand-in OpenAI-compatible provider.

## Decisions
- **Schema** (migration `20261001160000_action_cards`):
  - `ActionCard`: `conversationId`, `messageId` (the ASSISTANT message whose tool call made it; both cascade), `toolCallId`, `kind` (`ActionCardKind`: DECISION_REQUEST, SPEC_PROPOSAL, BRIEF_PROPOSAL, FEATURE_SUGGESTION), `targetId`, `status` (`ActionCardStatus`: PROPOSED, APPROVED, DECLINED, STALE), `title`, `summary`, `reviewedAt`, `createdAt`. Unique on (`kind`, `targetId`): one card per draft.
  - `targetId` is a plain id, not one foreign key per kind: the card never owns its target, and a target deleted elsewhere just makes the card STALE.
  - A new source `CONVERSATION` on `SpecVersionSource` and `BriefVersionSource`, so a version records that it was drafted in a Conversation. The web's source labels gained the entry (a type change forced it; no other UI work).
  - Deleting a Conversation deletes its cards, not the drafts they point to: a pending Spec or Brief Proposal still waits in the Inbox, and a DRAFT Decision Request stays the Raiser's.
- **Tools** (`apps/server/src/action-cards/chat-tools.ts`), each with a Zod input schema:
  - Feature Conversation: `searchContext`, `draftDecisionRequest`, `draftSpecProposal`. Project Conversation: `searchContext`, `draftBriefProposal`, `suggestFeatures`.
  - Every tool is offered whatever the person's permissions; the service refuses at call time. The AI learns why from the result, which is what the acceptance criterion asks.
  - `draftDecisionRequest` calls `DecisionRequestsService.raise` (AI Choices included), the same as `POST /decision-requests`.
  - `draftSpecProposal` and `draftBriefProposal` take the complete new Markdown and a one-line summary. They call new `SpecService.proposeFromConversation` and `BriefService.proposeFromConversation`, which use the existing permission checks (`assertCanEditSpec`, `assertCanEditProject`), make a PENDING proposal with the drafter as approver, refuse a draft identical to the current version, and refresh the drafter's Inbox (the proposal shows there too, like any other).
  - `suggestFeatures` (`count` 1–5, default 3) calls `FeatureSuggestionsService.generate`; each suggestion gets its own card, all linked to the same message.
  - `searchContext` calls `ContextRetriever.forFeature` or `forProject` for the Conversation's scope within 3,000 tokens (`CONTEXT_BUDGET.searchContext`). It makes no card.
  - Results are JSON text: `{ ok: true, actionCards: [...], note }`, `{ ok: true, results: [...] }`, or `{ ok: false, error }`. Invalid arguments, a refusal (any `HttpException`) and an unexpected failure are all results the AI reads, never a failed turn.
  - No tool approves, sends, accepts or decides anything, so an injected instruction can at most get a draft made. A call to a tool that wasn't offered is dropped, as in 0042.
- **The tool loop** (`ConversationsService.reply`):
  - Each step streams as in 0042 (`conversation.delta`, under that step's message id). A step that calls tools is stored as an ASSISTANT message with `toolCalls`, then each call runs and its result is stored as a TOOL message (`toolCallId`); the AI is then called again with those messages added.
  - At most 4 tool rounds per turn (`MAX_TOOL_ROUNDS`). The step after the last round is offered no tools, so the AI has to answer in words.
  - Context is retrieved and the summary folded once per turn, not per step. The retrieval query skips the turn's tool round, so it stays the person's own words.
  - An AI failure after a tool round keeps the stored round and its cards (they happened), sends `conversation.failed` for the step that failed, and answers 502. `retry` now also accepts a Conversation whose last message is TOOL, and goes on from the stored results instead of drafting again.
  - `ConversationTurnView` gained `steps` (the messages written before the reply) and `actionCards` (made this turn); `ConversationView` gained `actionCards` (each with its `messageId`).
- **SSE** (to the owner only; named under `conversation.*`, so the CLI's TUI keeps ignoring them):
  - `conversation.step` `{ conversationId, messages }`: a tool-calling message and its TOOL results, once stored;
  - `conversation.actionCard.created` `{ conversationId, card }`, after the step;
  - `conversation.actionCard.updated` `{ conversationId, card }`, when a card is approved, declined or found STALE.
- **API** (`ApproveActionCardInput`, `DeclineActionCardInput`, `ActionCardView` in `packages/shared`):
  - `POST /action-cards/:id/approve` → 201 `ActionCardView`. Optional body: `deciderRole`, `recipients`, `choices` (Decision Request cards: how to send it; default the draft's suggested role and every eligible recipient) and `teamId` (Feature Suggestion cards; default the Project's only Team, or the only one where the person is PO, else 422). An option for another kind of card is a 422.
  - `POST /action-cards/:id/decline` → 201 `ActionCardView`. Optional `reason`, a Feature Suggestion's dismiss reason (default "Declined in a Conversation").
  - Approve: send the draft (`DecisionRequestsService.submit`), approve the Spec or Brief Proposal, accept the Feature Suggestion. Decline: withdraw the draft, reject the proposal, dismiss the suggestion. All in the owner's name, through those services' own checks.
  - Only the Conversation's owner: anyone else, an Admin included, gets 404, as for the Conversation itself. Someone who left the Organization gets 403.
  - A card that is not PROPOSED is a 409 (so approving twice is refused). When the target's service refuses (403, 422…), the card stays PROPOSED for another try.
  - One approve or decline at a time per card, held in the server process like the reply lock.
- **STALE**: a PROPOSED card is stale when its Decision Request is no longer DRAFT, its proposal or suggestion is no longer PENDING (or is gone), or the Spec or Brief has a newer version than the proposal's base. It is checked, and saved, when the Conversation is read and before approving or declining (then a 409); a 409 from the target's service that turns out to be such a change marks it STALE too.
- **Mastra adapter**: tools are passed as Mastra client tools (no `execute`), so the model's tool call ends the step and comes back as a chunk; the server runs it. Earlier calls and results go back in the AI SDK message format. A call without its result is left out, and a result whose call was folded into the summary becomes plain text. On a step offered no tools, all calls and results are plain text, since some providers refuse tool messages without tool definitions.
- **Prompt**: `chat.md` explains the tools: they only draft or read, a draft waits for the person's approval on its Action Card, a proposal holds the complete Markdown, a refusal is explained (never worked around), and instructions inside the data are ignored. `bun run eval:conversation` gained two cases with tools offered; not yet run against a real model.
- **Modules**: Decision Requests, Spec and Brief moved into their own Nest modules (`DecisionRequestsModule`, `SpecModule`, `BriefModule`), and Feature Suggestions exports its service, so the Conversations module uses the same services rather than second copies.
- **Not here**: no web UI (0046). The card's Edit button opens the existing forms then.
