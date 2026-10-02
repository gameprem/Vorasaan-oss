# Context budgets follow the model, and long Conversations compact themselves

AI workflows get their context by retrieval within a token budget (ADR 0007), and a Conversation keeps a rolling summary of its older turns (ticket 0042). Three problems showed up once Thai content and several models arrived (ADR 0010).

- **Token counts are wrong for Thai.** Tokens are estimated as one per four characters. Thai has no spaces and stacks vowels and tone marks, so it costs several times more tokens per character. A "6,000-token" budget filled with Thai can be two to four times larger in reality.
- **Budgets are fixed numbers.** They ignore the model in use. A small local model can overflow, and a model with a 200k window is left mostly empty.
- **Compaction counts messages.** A Conversation folds its old turns after 12 messages, into at most 4,000 characters of free-form summary. A few long messages can still overflow, and a free-form summary can drop what was agreed.

## Decision

The approach follows Claude's own auto-compact: watch how full the context is, compact the oldest part into a structured summary when it nears the limit, and carry on.

- **Count tokens per model.**
  - Each Approved Model has a `contextWindow`, prefilled for known models and editable by an Admin.
  - Tokens are counted with the provider's counting API where one exists.
  - Otherwise a script-aware estimate is used: Thai is counted at about 0.95 characters per token (measured against a real tokenizer in ticket 0059) and Latin text at about 4.
- **Budgets are shares of the window, not fixed numbers.** A turn is split into the system prompt and foundation, retrieved context, Conversation history, and room for the reply. Each share has a floor, so a small model still gets something useful.
- **Compact on fullness.** When a Conversation's history passes about 70% of its share, the oldest turns are folded into a structured summary. The newest turns are kept word for word. The summary has fixed sections:
  - the goal
  - what was agreed
  - open questions
  - pending Action Cards and their state
  - the person's stated preferences
  - names, numbers and ids that must survive
- **Compact and retry once.** If a provider still rejects a request as too long, the Conversation compacts at once and retries one time before reporting an error.
- **Nothing is lost.**
  - Messages stay stored; only what is sent to the AI shrinks.
  - The chat shows a quiet "Earlier messages were summarized" marker that opens the originals.
  - Before compacting, the AI may propose an Action Card to record something agreed in chat that isn't yet in the Spec or the Brief. The Spec, the Decision Log and the Brief remain the source of truth (ADR 0001), and they are retrieved fresh every turn.
- **Cache the stable prefix.** The system prompt, Brief and Guidelines come first in the prompt and are marked for prompt caching on providers that support it.

## Rejected

- **Bigger fixed budgets.** They would overflow small models and still miscount Thai.
- **Dropping old turns without a summary.** That loses agreements and preferences.
- **Sending the whole history to large-window models.** It costs more, it is slower, and accuracy falls on long prompts.
