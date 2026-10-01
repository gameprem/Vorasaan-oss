# The web app is chat-first, and the AI only proposes from chat

The MVP web app is a set of forms and pages, one per workflow: raise a Decision Request, review Choices, approve a Spec Proposal, answer Grilling rounds, and so on. Teams find it easier to describe what they want to an AI, as they do in Claude or Gemini. After the MVP release we therefore make the web app **chat-first**:

- The left Sidebar holds the Inbox with its unread count, Projects and their Features, recent Conversations, and Settings at the bottom.
- The main area is a **Conversation** with the AI, scoped to a Project or a Feature.
- The Spec or Project Brief opens in a side panel next to the chat.

## The AI may only propose

In a Conversation the AI acts through tools, but every tool only **proposes**. A tool can do one of three things:

- create a draft (a Decision Request draft, a Spec Proposal, a Brief Proposal, a Feature Suggestion);
- read context that the user is already allowed to read;
- ask the user a question.

Each proposal appears in the chat as an **Action Card**. A person must press Approve or Send on the card, and that press calls the same API and service the form-based UI calls today. Permissions, the Decision Request state machine and the Inbox therefore stay in one place.

This keeps "AI proposes, human approves" (ADR 0001) even when a prompt injection hides in an Attachment. The worst an injected instruction can do is draft something a person then declines.

## Grilling moves into Conversations

Grilling becomes one Conversation per person, holding one of the round's Team Roles. In that Conversation the AI asks follow-up questions based on that person's answers, with a fixed limit per question. People still answer asynchronously, and each answer still records who gave it. When the rounds end, the AI combines all the threads into one Brief Proposal, as before (ADR 0006).

## What we rejected

- **A chat that writes directly.** It would be faster to use, but an Approve step is the product's core promise, and leaving it out would let an injected Attachment change a Spec.
- **One shared group chat per Project for Grilling.** People would talk over each other, and the AI could no longer tell whose answer belongs to which Team Role.
- **Keeping only the forms.** They remain as fallbacks, reachable from Action Cards and the side panel, but they are no longer the main way in.

## Consequences

- We add `Conversation` and `ConversationMessage` tables.
- Responses stream over the existing SSE channel.
- `AiPort` gains a tool-calling chat method, with a deterministic fake for tests.
- Messages are kept, and later turns get a summary of earlier ones plus retrieval (ADR 0007), not the whole history.
