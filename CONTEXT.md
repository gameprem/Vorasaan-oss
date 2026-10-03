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

**Platform**:
A part of the product a Feature can ship on, such as Back-End, Front-End, Mobile or Flutter. Each Project has its own list, started from a template. A Feature names the Platforms it targets.
_Avoid_: Tag, label, component, stack

**Coverage**:
For each Feature and each of its target Platforms, whether that Platform is covered or missing (for example no Spec section, nobody in the Team to ask, open Blockers, or no QA: no acceptance criteria or test cases, or nobody holding QA), using the checks that Platform has switched on.
_Avoid_: Completeness score, progress

**Role Owner**:
One of the people responsible for a given Team Role on a specific Feature. A Feature may have several Role Owners for the same Team Role.
_Avoid_: Assignee, owner

**Setup Token**:
A one-time secret that first-run setup requires, so only whoever runs the server can create the Organization and become its first Admin. The server prints it to its log while setup is needed, or the operator chooses it. It stops working once setup is done.
_Avoid_: Install key, admin password, invite code

**Getting started**:
The checklist an Admin sees on their Inbox after first-run setup: create a Project and a Team, create a Feature and write its Spec, invite members, link the CLI, and optionally turn on a Chat App. Each step ticks itself from what exists, never by hand. It goes away once every required step is done, or when that Admin dismisses it.
_Avoid_: Onboarding wizard, tutorial, todo list

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

**Request changes**:
The third answer to an AI proposal, next to Approve and Decline: a person explains what to change, optionally pointing at one part of it, and the AI writes a Redraft. Only those who may approve the proposal can request changes, and nothing changes until someone approves.
_Avoid_: Reject, change request, regenerate

**Redraft**:
The AI's rewrite of a proposal after Request changes, numbered from 2 (the first proposal is 1). It is the same proposal, not a new one. Each Redraft keeps the feedback that caused it, and Approve applies only the Redraft approved.
_Avoid_: Revision, version, iteration, retry

**Design Doc**:
The human-approved description of how one target Platform of a Feature will build what the Spec says, such as the API contract and data model for the Back-End, screens and states for the Front-End and Mobile, or the test plan for QA. The AI drafts it from the approved Spec once that Platform's Coverage is complete, and a Tech Lead or Role Owner of the Platform approves it. It follows the Spec and goes stale when the Spec changes; it never changes the Spec.
_Avoid_: SDD, tech spec, design spec, requirements doc

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
The outcome of a Decision Request: a picked Choice or a free-text answer. It records who decided, on whose behalf if acting as Delegate, and where: the web app, the CLI or a Chat App.
_Avoid_: Resolution, verdict

**Decision Log**:
The chronological list of a Feature's Decisions, each linked to the Spec Version it produced.
_Avoid_: Audit log, changelog

**Decision Graph**:
A Feature's Decision Log drawn like a git network graph: the Spec Versions form the main lane, and each Decision Request branches off at the Spec Version current when it was raised and merges back at the Spec Version it produced. Open requests are branches not yet merged.
_Avoid_: Timeline, history graph, git graph

### Attention

**Response Window**:
How long a Decision Request may wait for a decision before it escalates: reminders first, then the Delegate, then the Raiser and Tech Leads. It never changes who decides.
_Avoid_: SLA, deadline, timeout

**Working Time**:
The Organization's working days and working hours in its time zone, minus the public holidays an Admin lists. Response Windows count only Working Time; a working day is one day of working hours.
_Avoid_: Business hours, office hours, calendar time

**Escalation**:
The steps a Decision Request goes through once its Response Window runs out, each one written to its history: remind the Recipients; half a window later, add each Recipient's active Delegate as a Recipient; half a window after that, tell the Raiser and the Team's Tech Leads it is overdue. It never decides, Claims or reassigns.
_Avoid_: Auto-reassign, SLA breach, timeout

**Decision Lead Time**:
How long a Decision Request took from being sent to being decided, and how long it waited at each person.
_Avoid_: Cycle time, turnaround

**Inbox Item**:
Something a person must act on (decide a Decision Request, answer a request for more info, approve a Spec Proposal). It disappears when the action is done.
_Avoid_: Task, todo, notification

**Notification**:
An informational message a person only needs to read, such as a new Spec Version.
_Avoid_: Alert, inbox item

### Chat apps

**Chat App**:
LINE, Slack or Microsoft Teams, turned on by an Admin with the Organization's own bot, so people can get Decision Requests and answer them there.
_Avoid_: Messenger, channel, chat integration

**Chat Account**:
A person's account in a Chat App, linked to them with a Link Code. A message or button press counts as that person only when it comes from their Chat Account. A person has at most one per Chat App, and either side can unlink it.
_Avoid_: Connected account, chat user, chat identity

**Link Code**:
A one-time code Vorasaan shows a person, which they send to the Chat App's bot to link their Chat Account. It is valid for 10 minutes and works once.
_Avoid_: Pairing code, OTP, token

**Chat Card**:
What a person gets in their Chat App: a Decision Request with a button for each Choice, Ask for more info, Write your own answer, Request changes and Open in Vorasaan; or a NEEDS_INFO question, an escalation notice, or a link to review a Spec Proposal with Request changes. It shows only the title, the Choices and short status lines, never Attachment contents. Its buttons work only for the person it was sent to, from their linked Chat Account.
_Avoid_: Action Card (that is a Conversation's proposal), notification, chat message

**Quiet Hours**:
The hours of the day, in a person's time zone, when nothing is sent to their Chat Apps. Chat Cards wait until they end, and are sent then only if they still matter. Their Inbox has everything meanwhile.
_Avoid_: Do not disturb, mute

### Conversations

**Conversation**:
A person's chat with the AI, scoped to a Project or a Feature. The AI reads that scope's context and can only propose; nothing changes until a person approves an Action Card.
_Avoid_: Session, thread, chat room

**Grilling Conversation**:
A person's own Conversation for one Grilling round, opened for each person holding its Team Role. The AI asks the round's questions there one at a time and may ask up to two follow-ups on each answer; a question someone else already answered isn't asked again.
_Avoid_: Interview, Grilling thread

**AI Provider**:
A service an Admin connects with its own key (Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint, such as a local model). An Organization may connect several. Approved Models run on them.
_Avoid_: LLM integration, backend, vendor

**Approved Model**:
An AI model an Admin allows people to use, with a recognizable name (such as "Fast" or "Best") and the provider it runs on. One is the Organization default. Each AI task (Choices, Spec Proposals, summaries, Grilling, Feature Suggestions, the fit check, chat) uses the Approved Model the Admin set for it, or the default.
_Avoid_: Engine, LLM option, model preset

**Context Window**:
How much one call to an Approved Model can hold, the prompt and the reply together, counted in tokens. Every AI task takes its context, its history and its room for the reply as shares of it.
_Avoid_: Context length, max tokens, token limit

**Conversation Summary**:
The older part of a Conversation folded into fixed sections (the goal, what was agreed, open questions, pending Action Cards, the person's preferences, and names, numbers and ids) once the Conversation grows too long for its model. The AI then reads those messages only through it; the messages themselves stay in the Conversation.
_Avoid_: Memory, compaction note, recap

**Action Card**:
A proposal the AI makes inside a Conversation (a Decision Request draft, a Spec Proposal, a Brief Proposal, a Feature Suggestion), shown with the buttons to approve, edit, Request changes or decline it. A Request changes turns it into its next Redraft, in the same card. Only the Conversation's owner acts on it. It goes stale when what it proposes changes elsewhere (for example the proposal is approved from the Inbox), and can then no longer be approved or redrafted.
_Avoid_: Tool result, command, auto-action

### Learning

**Learning Loop**:
How Vorasaan learns from what people do with the AI's proposals: every AI call leaves a Receipt, people's outcomes are linked to it, and the AI proposes better Prompt Versions from them. Only an Admin's approval changes how the AI behaves; nothing is published automatically.
_Avoid_: Self-improvement, auto-tuning, training, fine-tuning

**Receipt**:
The record of one AI call: its task, prompt and Prompt Version, Approved Model, tokens, cache use, latency, what it produced, and what people then did with it (approved, declined, requested changes, edited by hand). Its export leaves out people's names and Attachment contents.
_Avoid_: Log, trace, usage record, telemetry

**Prompt Version**:
An immutable, numbered version of one of the AI's prompts held by an Organization, on top of the built-in default. The AI or an Admin proposes it, an Admin approves it after seeing its eval scores, and it can be rolled back.
_Avoid_: Prompt template, prompt revision, prompt draft, skill (that is an Agent Skill)

### Agent Skills

**Agent Skill**:
An installable package in the open SKILL.md format (a folder with a `SKILL.md` that has a name and a description, plus optional references and assets) that teaches the AI to do one thing in a particular way, such as drawing a diagram. An Admin installs it from GitHub or a zip, pinned to the version installed, and approves it; it is then enabled per Project. It is text and templates only: nothing in it is ever run, and it can only lead to proposals. "Skill" for short. It is not one of Vorasaan's own built-in prompts: those are prompts and Prompt Versions (the code keeps them in `packages/skills`).
_Avoid_: Plugin, extension, add-on, tool, prompt, built-in skill
