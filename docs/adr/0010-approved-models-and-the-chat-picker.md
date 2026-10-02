# Several AI providers, an approved model list, and a model picker in chat

Today an Organization connects one LLM provider with one model, and any per-task models come from server environment variables. People using the chat (ADR 0008) want to choose a model per Conversation, the way Claude or Gemini lets them: a fast one for a quick question, the strongest one for a Spec. Admins need to keep cost and data handling under control.

We decide:

- **Several providers at once.**
  - An Admin can connect any number of providers: Anthropic, OpenAI, and any OpenAI-compatible endpoint, such as a local model or a router.
  - Each is an `OrgIntegration` with its own encrypted key, as today.
- **An approved model list.**
  - The Admin adds **Approved Models**. Each one is a provider plus a model id, with a display name people recognize, such as "Fast", "Best" or "Local (no data leaves)", and an optional note.
  - Only Approved Models can be picked.
  - One Approved Model is the Organization default.
- **A picker in the chat.**
  - The composer has a model menu.
  - A Conversation remembers the model it was last sent with, and a new Conversation starts from the Organization default.
  - Every assistant message records the model that wrote it, so the Decision Log and the Spec history can show which model drafted a proposal.
- **Workflows outside chat** keep a model per AI task: Choices, Spec Proposal drafting, summaries, Grilling, Feature Suggestions and the fit check.
  - The Admin sets these in Settings, choosing from the Approved Models.
  - The `VORASAAN_MODEL_*` variables still win when they are set, so existing installs keep working.

**When a model fails or is removed:**
- If an Approved Model is removed, Conversations that used it fall back to the default on their next message, and the user is told.
- Nothing silently switches provider in the middle of a reply.

**Rejected:**
- **Every model a key can reach.** Costs can't be controlled, and model ids mean little to most people.
- **One provider only.** Teams that keep sensitive Projects on a local model couldn't also use a hosted one.
- **A per-user default.** It adds a setting nobody asked for. The Conversation remembers its model, which covers the need.
