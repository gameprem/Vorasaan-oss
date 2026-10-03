# Learning Loop: the system learns from human feedback, but only a person changes the AI's behaviour

Every day people approve, decline, request changes on and hand-edit what the AI proposes. That is the best signal we have about where the prompts fall short, and today we throw most of it away: the prompts in `packages/skills` change only when a developer edits them, and the eval sets (`bun run eval:*`) are run by hand against cases someone wrote once. Only Redraft feedback is kept as eval cases (ADR 0013), and nothing acts on it.

We add a **Learning Loop**, inspired by [Reef](https://github.com/Human-Agent-Society/reef) (Human-Agent Society, Apache-2.0). Reef records every agent call, attaches outcomes to it, evaluates, and evolves the prompts and skills around a model ("harness evolution") instead of its weights. We do the same:

- **A Receipt per AI call.** Every call records its task, the prompt and its Prompt Version, the Approved Model, tokens in and out, cache reads and writes, latency, a reference to its output, and the proposal it produced.
- **Human outcomes are the feedback.** Approve, Decline with its reason, Request changes with its feedback, the number of Redrafts before approval, and a manual edit after approval are linked to the Receipt that produced the proposal.
- **Evaluate.** An Admin runs the eval sets, plus a replay of approved Receipts, against a Prompt Version, and compares its scores with the current one.
- **Propose, don't publish.** The AI reads the feedback for a task ("Choices are often asked to be shorter") and proposes a new Prompt Version with its rationale and eval scores. Like every other AI proposal, an Admin approves it, requests changes or declines it. An approved Prompt Version can be rolled back.

Unlike Reef, nothing is published automatically. A Prompt Version changes how the AI answers everyone in the Organization, so it is a proposal an Admin approves, just as a Spec Proposal changes the Spec only once approved. "AI proposes, human approves" (ADR 0001) applies to the AI's own behaviour too.

## Boundaries

- **No weight training in the product.** Vorasaan doesn't fine-tune models. Receipts and their feedback can be exported, and an Organization may train elsewhere if it wants to.
- **No dependency on Reef.** We borrow the idea, not the code. The integration point is a documented JSONL export that Reef or any other tool can read.
- **Private by default.** The export leaves out people's names and Attachment contents. An Admin can turn collection off and set how long Receipts are kept.
- **Defaults stay in the repo.** The prompts in `packages/skills` stay the defaults. An Organization's own Prompt Versions sit on top of them in the database.

## Rejected

- **Publish automatically when scores improve.** Eval sets are small, and a prompt can overfit them. A regression nobody approved would reach every Decision Request in the Organization.
- **Fine-tuning in the product.** It needs GPUs, a pipeline per provider and far more data than one Organization produces, and it ties us to models we are allowed to train.
- **Running Reef inside Vorasaan.** It would add a second runtime and data model to every install. An export keeps the core small and lets teams pick their own tools.
- **Feedback only as eval cases (as today).** It records the signal but never acts on it.
