# Vorasaan

Vorasaan aligns business and engineering roles on what a feature must do before and during implementation. AI proposes; a human with the right role approves.

## Language

### Structure

**Organization**:
The company or body running one Vorasaan instance. It contains all Projects and people.
_Avoid_: Company, tenant, workspace

**Project**:
A product the company builds, such as "Mobile Banking". It may map to one Jira project.
_Avoid_: Product space, FeatureSpace

**Team**:
A group of people working on one Project.
_Avoid_: Squad, group

**Team Role**:
The hat a person wears in a Team: PO, Designer, Tech Lead, Backend, Frontend, Mobile or QA. One person may hold several Team Roles.
_Avoid_: Position, title

**Org Role**:
A person's administrative standing in the company: Admin or Member. It is unrelated to Team Role.
_Avoid_: Permission level

**Feature**:
A unit of product work owned by one Team, described by one Spec. It is epic-sized, and may link to one Jira Epic.
_Avoid_: FeatureSpec, ticket, story

**Role Owner**:
One of the people responsible for a given Team Role on a specific Feature. A Feature may have several Role Owners for the same Team Role.
_Avoid_: Assignee, owner

### Spec

**Spec**:
The living, human-approved description of what a Feature must do. It is the source of truth that AI coding assistants receive.
_Avoid_: PRD, SPEC.md, context file

**Spec Version**:
An immutable, numbered snapshot of a Spec, approved by a named person.
_Avoid_: Draft, history entry

**Attachment**:
An external document linked to a Feature or to a Project as a whole (a file, URL, or Confluence or Jira page) whose content is captured as a Snapshot.
_Avoid_: Reference, doc link

**Snapshot**:
The captured content of an Attachment at a point in time, used as AI context.
_Avoid_: Cache, copy

**Spec Proposal**:
An AI-drafted change to a Spec, awaiting approval. Once approved, it becomes a new Spec Version.
_Avoid_: Revision, change request, draft

### Project context

**Project Brief**:
The living, human-approved description of a Project as a whole: its business goals, users, what it already does, constraints and non-goals. Every AI workflow in the Project reads it.
_Avoid_: Project description, charter, PRD

**Brief Version**:
An immutable, numbered snapshot of a Project Brief, approved by a named person.
_Avoid_: Draft, history entry

**Brief Proposal**:
A drafted change to a Project Brief (for example from Grilling), awaiting approval. Once approved, it becomes a new Brief Version.
_Avoid_: Revision, change request, draft

**Grilling**:
Rounds of AI-asked questions to the people in a Project (business, then UX, then technical) whose answers the AI turns into a Project Brief proposal. Each person answers in their own Conversation, where the AI may ask follow-ups.
_Avoid_: Interview, survey, questionnaire

**Repo Scan**:
An opt-in summary of an existing codebase (README, dependencies, main modules and routes) that the CLI sends as context. It never contains whole source files.
_Avoid_: Code upload, import

**Feature Guidelines**:
The criteria a new Feature must meet for the business (goals it serves, constraints it respects). Set as an Organization default that a Project can override.
_Avoid_: Rules, policy, checklist

**Feature Suggestion**:
A Feature the AI proposes from the Project Brief, the Feature Guidelines and the Decision Log, with its rationale. A PO accepts it (it becomes a Feature) or dismisses it with a reason.
_Avoid_: Idea, recommendation, backlog item

### Decision Requests

**Decision Request**:
A request, raised on a Feature, for someone else to decide something. It is either a Blocker or a Question.
_Avoid_: Ticket, issue, escalation, ask

**Blocker**:
A Decision Request that stops the Raiser's work until it is decided. While any Blocker is open, the Feature is Blocked.
_Avoid_: Impediment

**Question**:
A Decision Request that lets the Raiser keep working meanwhile. It may be asked with Choices or as plain text.
_Avoid_: Clarification, query

**Raiser**:
The Role Owner who raised a Decision Request.
_Avoid_: Reporter, requester

**Decider**:
The one person currently responsible for deciding a Decision Request. The Decider is never the Raiser. A request sent to several Role Owners has no Decider until one of them Claims it.
_Avoid_: Assignee, approver, resolver

**Recipient**:
A person the Raiser sent a Decision Request to: one Role Owner of the decider role, or all of them (all Team members with that Team Role when the Feature has no such Role Owner). The Raiser is never a Recipient.
_Avoid_: Assignee, addressee

**Delegate**:
A person with the same Team Role who decides on someone's behalf during a set period, such as leave.
_Avoid_: Proxy, substitute, backup

**Claim**:
When someone with the required Team Role becomes the Decider of a Decision Request that has no Decider or was routed to someone else.
_Avoid_: Take, grab

**Choice**:
One of two to four AI-suggested, Raiser-reviewed options for a Decision Request, each with its impact on scope, time and risk.
_Avoid_: Option, answer, suggestion

**Decision**:
The outcome of a Decision Request: a picked Choice or a free-text answer. It records who decided, and on whose behalf if acting as Delegate.
_Avoid_: Resolution, verdict

**Decision Log**:
The chronological list of a Feature's Decisions, each linked to the Spec Version it produced.
_Avoid_: Audit log, changelog

### Attention

**Inbox Item**:
Something a person must act on (decide a Decision Request, answer a request for more info, approve a Spec Proposal). It disappears when the action is done.
_Avoid_: Task, todo, notification

**Notification**:
An informational message a person only needs to read, such as a new Spec Version.
_Avoid_: Alert, inbox item

### Conversations

**Conversation**:
A person's chat with the AI, scoped to a Project or a Feature. The AI reads that scope's context and can only propose; nothing changes until a person approves an Action Card.
_Avoid_: Session, thread, chat room

**Action Card**:
A proposal the AI makes inside a Conversation (a Decision Request draft, a Spec Proposal, a Brief Proposal, a Feature Suggestion), shown with the buttons to approve, edit or decline it.
_Avoid_: Tool result, command, auto-action
