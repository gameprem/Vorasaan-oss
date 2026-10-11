# Receipts export (JSONL)

Every AI call Vorasaan makes leaves a **Receipt**, and what people then did with the proposal it drafted (approve, decline, request changes, edit by hand) is linked to it (ADR 0015, the Learning Loop). An Admin downloads them from **Settings → AI models → Receipts → Export (JSONL)**, or from the API:

```bash
# An Admin's personal access token (Settings → Access tokens); the API listens on :4000 by default.
curl -H "Authorization: Bearer $VORASAAN_TOKEN" \
  "$VORASAAN_API_URL/settings/ai/receipts/export" > receipts.jsonl
```

`GET /settings/ai/receipts/export` is Admin only (403 for anyone else). It streams [JSON Lines](https://jsonlines.org/): one Receipt per line, oldest first, as `application/x-ndjson`. Each line parses with `ReceiptExportLine` from `@vorasaan/shared`.

The format is meant to leave Vorasaan: it can feed [Reef](https://github.com/Human-Agent-Society/reef) (whose traces are an agent call with outcomes attached), a notebook, a spreadsheet, or any other evaluation or training tool. Vorasaan itself never trains a model on it.

## What is in it, and what is not

- **No prompt and no reply.** A Receipt references what the call produced by id (`output`, `proposal`); it never holds a copy. The prompt's text is not stored at all, only its name and Prompt Version.
- **No person's name or email.** People appear as ids that are stable within one export (`person-1`, `person-2`…, in order of first appearance) and mean nothing outside it. In free text (Decline reasons, Request changes feedback, error messages) every person's name and email is replaced by their id, and any other email by `[email]`.
- **No Attachment contents.** A summary call's Receipt points at the Attachment's id only.
- **No secrets.** Error messages are stored short (300 characters), with the call's key and anything key-like masked.

Free text people wrote themselves (feedback, reasons) is kept, apart from names and emails: it is the feedback the Learning Loop learns from. Read it before sharing an export outside your Organization.

## A line

```json
{
  "format": "vorasaan.receipt/1",
  "id": "0b8f2a52-4c1e-4a4e-9d55-7f0f3c1a9e21",
  "at": "2026-10-01T09:00:00.000Z",
  "task": "draftSpecProposal",
  "taskKind": "SPEC_PROPOSAL",
  "prompt": { "name": "draft-spec-proposal", "version": "default@3f9a1c0b7d2e" },
  "model": {
    "source": "APPROVED_MODEL",
    "approvedModelId": "5d1e0c3a-8a5b-4f8e-9a0e-2a6f3d9b1c44",
    "name": "provider-model-id",
    "provider": "ANTHROPIC"
  },
  "language": "th",
  "usage": { "inputTokens": 4210, "outputTokens": 655, "cacheReadTokens": 3120, "cacheWriteTokens": 0 },
  "latencyMs": 8412,
  "success": true,
  "error": null,
  "output": { "kind": "SPEC_PROPOSAL", "id": "c7a4f1d2-6e0b-4c55-8b7e-1f2a3b4c5d6e" },
  "proposal": { "kind": "SPEC_PROPOSAL", "id": "c7a4f1d2-6e0b-4c55-8b7e-1f2a3b4c5d6e", "redraft": 1 },
  "requestedBy": "person-1",
  "agentSkills": [],
  "outcomes": [
    {
      "kind": "REQUEST_CHANGES",
      "at": "2026-10-01T09:05:12.000Z",
      "redraft": 1,
      "text": "Mention the retry limit, and ask person-2 about it",
      "redraftsBeforeApproval": null,
      "choiceLabel": null,
      "editSize": null,
      "by": "person-1"
    },
    {
      "kind": "APPROVE",
      "at": "2026-10-01T09:07:40.000Z",
      "redraft": 2,
      "text": null,
      "redraftsBeforeApproval": 1,
      "choiceLabel": null,
      "editSize": null,
      "by": "person-1"
    },
    {
      "kind": "MANUAL_EDIT",
      "at": "2026-10-01T10:15:02.000Z",
      "redraft": 2,
      "text": null,
      "redraftsBeforeApproval": null,
      "choiceLabel": null,
      "editSize": 4,
      "by": "person-1"
    }
  ]
}
```

(Shown over several lines here; in the file each Receipt is one line.)

## Fields

| Field | Meaning |
| --- | --- |
| `format` | Always `vorasaan.receipt/1`. A breaking change bumps the number. |
| `id`, `at` | The Receipt's id, and when the call started (ISO 8601, UTC). |
| `task` | The AI call: `generateChoices`, `draftSpecProposal`, `draftSpecFromAttachments`, `draftSpecFromSuggestion`, `summarizeAttachment`, `grillingQuestions`, `grillingFollowUp`, `draftBriefFromGrilling`, `suggestFeatures`, `checkFeatureFit`, `chat`, `summarizeConversation`, `redraftChoices`, `redraftSpecProposal`, `redraftBriefProposal`, `redraftFeatureSuggestion`, `draftAcceptanceCriteria`, `draftDesignDoc`, `redraftDesignDoc`. New tasks may appear. |
| `taskKind` | The Settings task it belongs to (`CHOICES`, `SPEC_PROPOSAL`, `SUMMARIES`, `GRILLING`, `FEATURE_SUGGESTIONS`, `FIT_CHECK`, `CHAT`). |
| `prompt.name`, `prompt.version` | The prompt the call rendered and its Prompt Version. `default@<hash>` is the built-in prompt; the hash (12 hex digits of its SHA-256) changes whenever its text does. `v<n>@<hash>` is the Organization's Prompt Version number `n` (0071), hashed the same way. The calls of an Eval Run (0071) leave Receipts too; they have no outcomes. |
| `model` | `source`: `APPROVED_MODEL` or `ENV` (a `VORASAAN_MODEL*` variable); `approvedModelId`; `name`, the provider's model id; `provider`: `ANTHROPIC`, `OPENAI`, `OPENAI_COMPATIBLE` or `OPENROUTER`. |
| `language` | The Reply Language the call was asked for (`en`, `th`). |
| `usage` | Tokens in and out, and read from and written to the provider's prompt cache, summed over the call's requests (a structured call retried after an invalid answer counts both). `null` when the provider didn't say. |
| `latencyMs` | How long the call took, end to end. |
| `success`, `error` | Whether it returned. A failed call has a Receipt too, with a short, redacted `error`. A chat reply stopped by the person counts as failed ("Stopped by the person"). |
| `output` | What it produced, by reference: `CHOICES` (a Decision Request's id), `SPEC_PROPOSAL`, `BRIEF_PROPOSAL`, `FEATURE_SUGGESTION_BATCH` (the batch of Feature Suggestions generated together), `REDRAFT` (a Redraft's id), `CONVERSATION_MESSAGE` (a reply), `CONVERSATION` (a Conversation Summary), `ATTACHMENT` (a summary), `GRILLING_ROUND` (its questions), `GRILLING_QUESTION` (a follow-up), `PROMPT_ANALYSIS` (the patterns the AI found in a prompt's feedback) `PROMPT_VERSION` (a Prompt Version it proposed) and `DESIGN_DOC_PROPOSAL` (a Design Doc it drafted, ticket 0069). `null` for the fit check, which stores nothing. The id may point at nothing if writing the output failed after the call. |
| `proposal` | The proposal it drafted (`redraft` 1) or redrafted (2, 3…): `CHOICES`, `SPEC_PROPOSAL`, `BRIEF_PROPOSAL`, `FEATURE_SUGGESTION`, `PROMPT_VERSION` (one the AI proposed, ticket 0072) or `DESIGN_DOC_PROPOSAL` (ticket 0069). |
| `requestedBy` | Whose action made the call; `null` for what runs on its own (a Grilling moving on, a Feedback Analysis started by new feedback). |
| `agentSkills` | The Agent Skills (0078) whose text the call read, each `{ name, pinned }`: the Skill's name and the commit SHA or `sha256:<hex>` of the zip it is pinned to. Empty for most calls. |
| `outcomes` | What people did with the proposal, oldest first (below). |

### Outcomes

| `kind` | When | Extra fields |
| --- | --- | --- |
| `APPROVE` | A Spec or Brief Proposal approved; a Feature Suggestion accepted; a Decision made with one of the AI's Choices. | `redraftsBeforeApproval`: Redrafts written before it (0 when approved as first drafted); `choiceLabel` for Choices. |
| `DECLINE` | A proposal rejected, a Feature Suggestion dismissed, a draft Decision Request withdrawn, or a Decision made with an answer of the Decider's own instead of the Choices. | `text`: the reason, when one was given. |
| `REQUEST_CHANGES` | Someone asked for a Redraft (ADR 0013). | `text`: the feedback. |
| `MANUAL_EDIT` | The Raiser edited the Choices before sending them, or the Spec or Brief was edited by hand in the very next version after an approved proposal's. | `editSize`: lines added plus lines removed. |

Every outcome has `redraft` (the Redraft it was given on) and `by`.

On the Receipt that **drafted** a proposal (`proposal.redraft` 1, or the `suggestFeatures` batch, or the chat reply whose tool call drafted it), `outcomes` lists every outcome of that proposal. On a **Redraft's** Receipt, it lists only the outcomes given on that Redraft, so each line can be read on its own.

## Retention and collection

An Admin turns collection off or on (on by default) and sets how many days Receipts are kept (90 by default) in the same section. Turning collection off stops new Receipts and outcomes; those already there follow the retention. A daily job deletes Receipts past it, with their outcomes, so an export only ever holds what is still kept.

## Related

- `GET /redrafts/eval-cases` (ticket 0065) still exports every Request changes as an eval case for the redraft prompts: the proposal before and after, with the feedback. The Receipts export is the wider record; the eval cases are the ready-made test set.
