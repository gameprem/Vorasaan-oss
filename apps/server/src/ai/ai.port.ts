import {
  AttachmentSource,
  ChoiceDraft,
  ChoiceDrafts,
  DecisionRequestKind,
  type GrillingRoundKind,
  GuidelineCriterionKind,
  GuidelineFitVerdict,
  MAX_GRILLING_QUESTIONS,
  type ProposalKind,
  type ReceiptOutcomeKind,
  type ReceiptOutputKind,
  SuggestionLevel,
  TeamRole,
} from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import { z } from 'zod';
import type { ReplyLanguage } from './language.ts';
import type { ResolvedProvider } from './model-config.ts';
import type { WorkflowMemory } from './workflow-memory.ts';

// The only way server code talks to an LLM. Production uses MastraAiPort;
// tests use FakeAiPort, so no test ever hits the network.

export const AI_PORT = Symbol('AI_PORT');

export type RequestForAi = {
  kind: DecisionRequestKind;
  title: string;
  description: string;
  raiserRole: TeamRole;
};

export const GeneratedChoices = z.object({
  suggestedRole: TeamRole,
  choices: ChoiceDrafts,
});
export type GeneratedChoices = z.infer<typeof GeneratedChoices>;

export type DecisionForAi =
  | { kind: 'choice'; choice: ChoiceDraft; rationale?: string | null }
  | { kind: 'custom'; answer: string; rationale?: string | null };

export const SpecProposalDraft = z.object({
  proposedMarkdown: z.string().trim().min(1),
  summary: z.string().trim().min(1),
});
export type SpecProposalDraft = z.infer<typeof SpecProposalDraft>;

/**
 * An Attachment's Snapshot (or its summary) as AI context. `text` is untrusted:
 * it comes from outside documents, so prompts fence it off as data.
 */
export type AttachmentForAi = {
  title: string;
  source: AttachmentSource;
  text: string;
};

/** Where a block of AI context comes from, so outputs can cite it by `id`. */
export type ContextSource = {
  kind:
    | 'SPEC_VERSION'
    | 'DECISION_REQUEST'
    | 'DECISION'
    | 'ATTACHMENT'
    | 'BRIEF_VERSION'
    /** A Feature's title, status and description, for a Feature with no Spec yet. */
    | 'FEATURE';
  id: string;
  title: string;
  /** The Spec or Brief Version number, for Spec and Project Brief blocks. */
  version?: number;
};

/**
 * One block of retrieved context (ADR 0007): all or part of a Spec, a Decision
 * Request, a Decision or an Attachment. `text` is untrusted, so prompts fence it
 * off as data. `scope` says whether it belongs to the Feature being worked on or
 * to the rest of its Project.
 */
export type ContextBlock = {
  source: ContextSource;
  scope: 'FEATURE' | 'PROJECT';
  text: string;
};

export type FeatureForAi = { title: string; description: string };

/**
 * A Platform of the Project (ADR 0009) as AI input: its name, which is its Spec section's
 * `##` heading, and the Team Roles who can answer for it. Names are written by people:
 * untrusted, fenced like any data.
 */
export type PlatformForAi = { name: string; roles: TeamRole[] };

/**
 * A Design Doc (ADR 0014, ticket 0069) as AI input: its name ("Back-End", or "QA"), the
 * Platform it is for (null for QA), the Feature's target Platforms (which QA covers, and
 * whose sections a Platform's Design Doc leaves out), and the template it follows. Names and
 * the template are written by people: untrusted, fenced like any data.
 */
export type DesignDocForAi = {
  name: string;
  platform: PlatformForAi | null;
  targets: PlatformForAi[];
  template: string;
};

/** The most questions one Design Doc draft raises as Decision Requests. */
export const MAX_DESIGN_DOC_QUESTIONS = 5;

export const DesignDocDraft = z.object({
  proposedMarkdown: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(1_000),
  /** What the design needs that the Spec and the Decisions don't settle: each a Question. */
  questions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000),
      }),
    )
    .max(MAX_DESIGN_DOC_QUESTIONS),
});
export type DesignDocDraft = z.infer<typeof DesignDocDraft>;

export const AttachmentSummary = z.object({
  summary: z.string().trim().min(1),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;

/** One effective Feature Guidelines criterion (0031). Its text is untrusted. */
export type GuidelineForAi = {
  /**
   * A short handle ("G1", "G2"...) the AI cites the criterion by, when the task
   * returns criteria (Feature Suggestions, the fit check). The server maps it
   * back to the criterion and drops any handle it didn't give.
   */
  ref?: string;
  title: string;
  description: string;
  kind: GuidelineCriterionKind;
  required: boolean;
};

/**
 * What every AI workflow in a Project reads (ADR 0006): the latest Brief Version
 * (shortened to fit) and the effective Feature Guidelines. Both are untrusted.
 */
export type ProjectFoundationForAi = {
  brief: { version: number; markdown: string } | null;
  guidelines: GuidelineForAi[];
};

/** A follow-up the AI asked on a Grilling question, and the reply. Both untrusted. */
export type GrillingFollowUpForAi = { question: string; answer: string };

/**
 * One answered Grilling question, with who answered it (and as which Team Role)
 * and the follow-ups asked in their Grilling Conversation (ticket 0044), so the
 * Brief draft keeps the attribution. `answer` and the follow-ups are people's
 * own words, and the name is theirs: untrusted.
 */
export type GrillingAnswerForAi = {
  round: GrillingRoundKind;
  question: string;
  answer: string;
  answeredBy: { name: string; role: TeamRole } | null;
  followUps: GrillingFollowUpForAi[];
};

/**
 * Whether to ask one more follow-up on a Grilling question (ticket 0044): its
 * text, or null to move on. The server asks at most MAX_GRILLING_FOLLOW_UPS,
 * whatever this says.
 */
export const GrillingFollowUpDecision = z.object({
  followUp: z.string().trim().max(2_000).nullable(),
});
export type GrillingFollowUpDecision = z.infer<typeof GrillingFollowUpDecision>;

export type ProjectForAi = { name: string };

/** 0 to 7 questions: fewer when what is known already answers the round. */
export const GrillingQuestionDrafts = z.object({
  questions: z.array(z.string().trim().min(1).max(2_000)).max(MAX_GRILLING_QUESTIONS),
});
export type GrillingQuestionDrafts = z.infer<typeof GrillingQuestionDrafts>;

export const BriefDraft = z.object({
  proposedMarkdown: z.string().trim().min(1),
  summary: z.string().trim().min(1),
});
export type BriefDraft = z.infer<typeof BriefDraft>;

/** The most Feature Suggestions one AI call may return. */
export const MAX_SUGGESTIONS_FROM_AI = 10;

export const FeatureSuggestionDraft = z.object({
  title: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(4_000),
  businessValue: z.string().trim().min(1).max(2_000),
  effort: SuggestionLevel,
  risk: SuggestionLevel,
  /** The `ref`s of the Guidelines it serves. */
  servesGuidelines: z.array(z.string().trim().min(1).max(20)).max(50),
});
export type FeatureSuggestionDraft = z.infer<typeof FeatureSuggestionDraft>;

export const FeatureSuggestionDrafts = z.object({
  suggestions: z.array(FeatureSuggestionDraft).max(MAX_SUGGESTIONS_FROM_AI),
});
export type FeatureSuggestionDrafts = z.infer<typeof FeatureSuggestionDrafts>;

/** A Feature Suggestion someone dismissed, and why. Its texts are untrusted. */
export type DismissedSuggestionForAi = { title: string; rationale: string; reason: string };

/** A Feature Suggestion (being accepted) as AI input. Its texts came from the AI; still data. */
export type SuggestionForAi = {
  title: string;
  rationale: string;
  businessValue: string;
  effort: SuggestionLevel;
  risk: SuggestionLevel;
};

export const FeatureFitDraft = z.object({
  results: z
    .array(
      z.object({
        /** The Guideline's `ref`. */
        guideline: z.string().trim().min(1).max(20),
        verdict: GuidelineFitVerdict,
        reason: z.string().trim().min(1).max(1_000),
        /** For an UNCLEAR verdict: what to ask to settle it. */
        question: z.string().trim().max(1_000).nullish(),
      }),
    )
    .max(100),
});
export type FeatureFitDraft = z.infer<typeof FeatureFitDraft>;

/** What a Conversation (ticket 0042) is about, as the AI sees it. Titles are untrusted. */
export type ConversationScopeForAi =
  | { kind: 'PROJECT'; project: ProjectForAi }
  | { kind: 'FEATURE'; project: ProjectForAi; feature: FeatureForAi };

/**
 * An Agent Skill (ADR 0017, ticket 0078) enabled in the Project and approved, as the prompt
 * lists it: only its name and description (progressive disclosure). Both come from a
 * third-party SKILL.md: untrusted, fenced as data.
 */
export type AgentSkillForAi = { name: string; description: string };

/** A tool the AI called, as stored on its message. `args` came from the AI: untrusted. */
export type ChatToolCall = { id: string; name: string; args: unknown };

/**
 * One message of a Conversation as AI input. USER content is the owner's own words;
 * ASSISTANT content (and its tool calls) is earlier AI output; TOOL is a tool's
 * result for the call `toolCallId`. All of it is untrusted data.
 */
export type ChatMessageForAi =
  | { role: 'USER'; content: string }
  | { role: 'ASSISTANT'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'TOOL'; content: string; toolCallId: string };

/**
 * A tool the AI may call in a Conversation. Every tool only drafts or reads
 * (ADR 0008); the server runs it, never the model, and gives the AI its result
 * as a TOOL message. Drafts become Action Cards (0043, `action-cards/chat-tools.ts`).
 */
export type ChatTool = { name: string; description: string; inputSchema: z.ZodType };

/**
 * One step's token usage, as the provider reported it (tickets 0061, 0066): the
 * input, and the part of it read from the provider's prompt cache. Either is null
 * when the provider doesn't say.
 */
export type ChatUsage = { inputTokens: number | null; cacheReadTokens: number | null };

/**
 * What a chat reply streams: pieces of its text, the tools it calls, and, last,
 * the step's usage when the provider reports it.
 */
export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ChatToolCall }
  | { type: 'usage'; usage: ChatUsage };

const SummaryItems = z.array(z.string().trim().min(1).max(1_000)).max(60);

/**
 * A Conversation Summary (ticket 0060, ADR 0012): the older turns of a
 * Conversation folded into fixed sections, so what was agreed survives. The
 * server renders it as Markdown (`renderConversationSummary`) and stores it.
 */
export const ConversationSummaryDraft = z.object({
  /** What the person is trying to do in this Conversation. */
  goal: z.string().trim().max(2_000),
  /** What the person and the assistant agreed on, decided or settled. */
  agreed: SummaryItems,
  /** Questions still open. */
  openQuestions: SummaryItems,
  /** Action Cards still waiting for a decision, each with its state. */
  pendingActionCards: SummaryItems,
  /** The person's stated preferences (language, tone, format, priorities). */
  preferences: SummaryItems,
  /** Names, numbers and ids that must survive word for word. */
  keyFacts: SummaryItems,
});
export type ConversationSummaryDraft = z.infer<typeof ConversationSummaryDraft>;

/**
 * A fold (ticket 0066): the Conversation Summary, and the agreed points the Spec or
 * the Brief it was given doesn't record yet (none when it was given neither).
 */
export const ConversationFoldDraft = ConversationSummaryDraft.extend({
  /** Agreed points not yet in the Spec or the Brief given, each as it should be recorded. */
  unrecorded: SummaryItems,
});
export type ConversationFoldDraft = z.infer<typeof ConversationFoldDraft>;

/** The Spec (Feature) or the Project Brief (Project) a fold checks agreed points against. */
export type RecordForAi = { kind: 'SPEC' | 'BRIEF'; markdown: string };

// ─── Request changes (ADR 0013, ticket 0065) ────────────────────────────────

/**
 * One Request changes as AI input: the person's words and the part of the proposal they
 * pointed at (rendered with its text, e.g. "Choice B: Poll every 5 s"), if any. Both are
 * untrusted: prompts fence them as data that may only change the proposal.
 */
export type FeedbackForAi = { redraft: number; feedback: string; pointer: string | null };

const RedraftNotes = {
  /** What this Redraft changed from the one before. */
  summary: z.string().trim().min(1).max(1_000),
  /** Lasting preferences the feedback states (language, length, style); none for a content change. */
  preferences: z.array(z.string().trim().min(1).max(300)).max(10),
};

export const RedraftedChoices = z.object({ choices: ChoiceDrafts, ...RedraftNotes });
export type RedraftedChoices = z.infer<typeof RedraftedChoices>;

export const RedraftedMarkdown = z.object({
  proposedMarkdown: z.string().trim().min(1),
  ...RedraftNotes,
});
export type RedraftedMarkdown = z.infer<typeof RedraftedMarkdown>;

export const RedraftedSuggestion = z.object({
  title: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(4_000),
  businessValue: z.string().trim().min(1).max(2_000),
  effort: SuggestionLevel,
  risk: SuggestionLevel,
  ...RedraftNotes,
});
export type RedraftedSuggestion = z.infer<typeof RedraftedSuggestion>;

/** What every redraft takes besides the proposal: the latest feedback and the earlier ones. */
export type RedraftFeedbackForAi = {
  /** The number of the Redraft being changed (the current one). */
  current: number;
  feedback: FeedbackForAi;
  /** Feedback on earlier Redrafts of the same proposal, oldest first. */
  earlier: FeedbackForAi[];
};

// ─── The AI proposes Prompt Versions (ADR 0015, ticket 0072) ────────────────

/** A prompt as the Learning Loop's AI calls see it: its packages/skills name and the tasks that render it. */
export type PromptForAi = { name: SkillName; tasks: string[] };

/**
 * One human outcome of a proposal the prompt drafted (ticket 0070), as AI input. `text` is a
 * person's own words (a decline reason, Request changes feedback): untrusted.
 */
export type FeedbackCaseForAi = {
  /** 1-based: the AI cites a case by it. */
  index: number;
  outcome: ReceiptOutcomeKind;
  proposal: ProposalKind;
  /** The Redraft it was given on. */
  redraft: number;
  text: string | null;
  redraftsBeforeApproval: number | null;
  choiceLabel: string | null;
  /** MANUAL_EDIT: lines added plus removed. */
  editSize: number | null;
};

/** The most patterns one analysis names. */
export const MAX_FEEDBACK_PATTERNS = 8;

export const FeedbackAnalysis = z.object({
  patterns: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(2_000),
        /** The `index` of each case that shows it. */
        cases: z.array(z.int().min(1)).max(1_000),
      }),
    )
    .max(MAX_FEEDBACK_PATTERNS),
});
export type FeedbackAnalysis = z.infer<typeof FeedbackAnalysis>;

/** A pattern as the proposal is given it: the cases' own words are untrusted. */
export type PatternForAi = {
  title: string;
  description: string;
  count: number;
  /** A few of its cases' words, as written. */
  examples: string[];
};

export const ProposedPromptVersion = z.object({
  template: z.string().trim().min(1).max(100_000),
  rationale: z.string().trim().min(1).max(4_000),
});
export type ProposedPromptVersion = z.infer<typeof ProposedPromptVersion>;

export const RedraftedPromptVersion = ProposedPromptVersion.extend(RedraftNotes);
export type RedraftedPromptVersion = z.infer<typeof RedraftedPromptVersion>;

/** An Action Card of the Conversation, as the summary is told about it. Its title is untrusted. */
export type ActionCardForAi = { kind: string; title: string; status: string };

/**
 * The model one AI call runs on, chosen by the server for that call (ADR 0010).
 * It holds the decrypted key: never log it or send it to a client.
 */
export type ModelChoice = {
  /** An Approved Model, or a `VORASAAN_MODEL*` env var. */
  source: 'APPROVED_MODEL' | 'ENV';
  /** Set when `source` is APPROVED_MODEL. */
  approvedModelId: string | null;
  /** The provider (OrgIntegration) whose key is used; null when the key comes from env. */
  integrationId: string | null;
  /** The provider and model id with its key; null for an env "provider/model" read from env keys. */
  provider: ResolvedProvider | null;
  /** The model id, or the env "provider/model" string. Safe to show. */
  name: string;
  /**
   * Tokens one call may hold, prompt and reply together (ticket 0060): the Approved
   * Model's, or for an env model VORASAAN_CONTEXT_WINDOW, else its known window.
   * Every budget of the call is a share of it (`planBudget`).
   */
  contextWindow: number;
};

/**
 * Per-call options every AiPort method takes.
 * - `approvedModelId`: the caller picks the model (the chat picker, 0054). An
 *   unknown one falls back to the task's model.
 * - `model`: the resolved model, filled in by `ModelRoutingAiPort` before the call
 *   reaches the provider adapter (or the fake). A caller that chose it already
 *   (`AiSettingsService.chooseModel`) passes it, and it is kept as is: a
 *   Conversation's turn chooses once, so all its steps run on one model (0054).
 * - `language`: the reply language (ticket 0068, `personLanguage` or
 *   `projectLanguage`); left out, English.
 */
export type AiCallOptions = {
  approvedModelId?: string;
  model?: ModelChoice;
  language?: ReplyLanguage;
  /**
   * The version of the task's prompt (ticket 0071), filled in by `ModelRoutingAiPort`:
   * the Organization's active Prompt Version, or the built-in default. An eval run
   * passes the version it evaluates, and it is kept as is.
   */
  prompt?: PromptChoice;
  /** What the call's Receipt links to (ticket 0070): who asked, what it produces. */
  receipt?: ReceiptLink;
  /**
   * Told each provider call's usage (filled in by `ReceiptingAiPort`): a structured call
   * retried after an invalid answer reports twice, and the Receipt sums them.
   */
  onUsage?: (usage: CallUsage) => void;
};

/**
 * The version of a prompt one AI call renders (ADR 0015, ticket 0071): the built-in
 * default (`template` null) or an Organization's Prompt Version.
 */
export type PromptChoice = {
  /** The packages/skills name. */
  name: SkillName;
  /** As Receipts name it: `default@<hash>` or `v<n>@<hash>`. */
  version: string;
  /** The Prompt Version's number; 0 for the default. */
  number: number;
  /** The Prompt Version's template as written; null renders the built-in default. */
  template: string | null;
};

/** One provider call's tokens, as reported (tickets 0061, 0070); null when it doesn't say. */
export type CallUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Of `outputTokens`, those spent thinking (ticket 0080); null when not reported. */
  reasoningTokens: number | null;
};

/**
 * What a call's Receipt (ADR 0015, ticket 0070) points at, by id: the person whose action
 * made the call, what it produces (the Choices of a request, a Redraft, a reply...), and
 * the proposal it drafts or redrafts with the Redraft's number. Ids may be chosen before
 * the row is written; a Receipt never holds a copy of the output.
 */
export type ReceiptLink = {
  requestedById?: string | null;
  output?: { kind: ReceiptOutputKind; id: string } | null;
  proposal?: { kind: ProposalKind; id: string; redraft: number } | null;
  /** The eval run (ticket 0071) the call is made for: a replay never picks its Receipt. */
  evalRunId?: string | null;
  /**
   * The Project the call works for (ticket 0075), or its Feature, whose Project the Receipt
   * then looks up in the background. Neither: Organization-wide work.
   */
  projectId?: string | null;
  featureId?: string | null;
  /**
   * The Agent Skills whose text the call reads (ticket 0078): those loaded with `loadSkill`
   * or `readSkillFile` earlier in its Conversation turn.
   */
  agentSkills?: ReceiptAgentSkillLink[];
};

/** An Agent Skill a call read, as its Receipt records it (by version, and pinned commit or hash). */
export type ReceiptAgentSkillLink = {
  skillId: string;
  versionId: string;
  name: string;
  pinned: string;
};

// Every method takes an optional last `options?: AiCallOptions`.
export interface AiPort {
  /**
   * The AI's reply in a Conversation (ticket 0042), streamed as it is written.
   * It gets the scope's retrieved context, the summary of earlier turns and only
   * the most recent messages (ADR 0007), never the whole history. Iterating
   * throws when the provider fails; `signal` stops the reply.
   */
  chat(
    input: {
      scope: ConversationScopeForAi;
      /** Retrieved context: ContextRetriever.forFeature or forProject. */
      context: ContextBlock[];
      /** The Project Brief (Feature scope) and the effective Guidelines. */
      foundation: ProjectFoundationForAi;
      /** Earlier turns folded together; empty before the first fold. */
      summary: string;
      /** The messages after the summary, oldest first, ending with the owner's latest. */
      recentMessages: ChatMessageForAi[];
      /** The tools offered on this step; none on the last step of a turn. */
      tools: ChatTool[];
      /**
       * In a Feature Conversation, its target Platforms the latest Spec has no section for
       * (Coverage, ticket 0052): the AI may offer to add one as a Spec Proposal Action Card.
       * None when left out.
       */
      missingSections?: PlatformForAi[];
      /**
       * The Agent Skills enabled in the Project and approved (ticket 0078): names and
       * descriptions only; the AI reads one with the `loadSkill` tool. None when left out.
       */
      agentSkills?: AgentSkillForAi[];
      signal?: AbortSignal;
    },
    options?: AiCallOptions,
  ): AsyncIterable<ChatChunk>;

  /**
   * The Conversation Summary with `messages` (the oldest not yet in it) folded
   * in, in its fixed sections (ticket 0060).
   */
  summarizeConversation(
    input: {
      scope: ConversationScopeForAi;
      /** The Conversation Summary so far (rendered), or empty before the first fold. */
      summary: string;
      messages: ChatMessageForAi[];
      /** The Conversation's Action Cards and their state, for "pending Action Cards". */
      actionCards: ActionCardForAi[];
      /** What the person asked the summary to keep (`/compact <focus>`, ticket 0066). Untrusted. */
      focus?: string | null;
      /** Check agreed points against this Spec or Brief (`unrecorded`); left out, none are checked. */
      record?: RecordForAi | null;
    },
    options?: AiCallOptions,
  ): Promise<ConversationFoldDraft>;

  /**
   * How many tokens `system` and `messages` cost on the call's model (ticket
   * 0060): the provider's counting API where there is one, else the script-aware
   * estimate (ticket 0059). Counted once per turn, never per chunk. Never throws
   * for a counting failure: it falls back to the estimate.
   */
  countTokens(
    input: { system: string; messages: ChatMessageForAi[] },
    options?: AiCallOptions,
  ): Promise<number>;

  generateChoices(
    input: {
      specMarkdown: string;
      request: RequestForAi;
      /** Retrieved context, most important first, without the Feature's own Spec. */
      context: ContextBlock[];
      /** The Project Brief and effective Guidelines (0034); none when left out. */
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ): Promise<GeneratedChoices>;

  draftSpecProposal(
    input: {
      specMarkdown: string;
      request: RequestForAi;
      decision: DecisionForAi;
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
      /**
       * Target Platforms the Spec has no section for (Coverage, ticket 0051): the draft fills
       * each section or puts an open question in it. None when left out.
       */
      missingSections?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ): Promise<SpecProposalDraft>;

  summarizeAttachment(
    input: { attachment: AttachmentForAi },
    options?: AiCallOptions,
  ): Promise<AttachmentSummary>;

  /** A complete Spec drafted from the Feature's Attachments (and the current Spec, if any). */
  draftSpecFromAttachments(
    input: {
      feature: FeatureForAi;
      specMarkdown: string;
      context: ContextBlock[];
      /** Target Platforms the Spec has no section for (ticket 0051); none when left out. */
      missingSections?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ): Promise<SpecProposalDraft>;

  /**
   * The questions of one Grilling round (ticket 0032), only about what the
   * Project context and the earlier rounds leave unanswered.
   */
  grillingQuestions(
    input: {
      project: ProjectForAi;
      round: GrillingRoundKind;
      role: TeamRole;
      /** Retrieved Project context, the current Brief first (ContextRetriever.forProject). */
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
      /** Summaries of the rounds already done. */
      memory: WorkflowMemory;
      /** The Project's Platforms no Feature covers (ticket 0051), to ask about; none when left out. */
      uncoveredPlatforms?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ): Promise<GrillingQuestionDrafts>;

  /**
   * In a Grilling Conversation (ticket 0044), after the person's answer to a
   * question (and to any follow-ups so far): one more follow-up when the answer
   * is thin, vague or contradicts itself, or null to move on.
   */
  grillingFollowUp(
    input: {
      project: ProjectForAi;
      round: GrillingRoundKind;
      role: TeamRole;
      question: string;
      answer: string;
      /** The follow-ups asked so far, each with its reply. */
      followUps: GrillingFollowUpForAi[];
      /** How many more the server would still ask (at least 1). */
      remaining: number;
    },
    options?: AiCallOptions,
  ): Promise<GrillingFollowUpDecision>;

  /** The complete next Project Brief, from every Grilling answer and the Project context. */
  draftBriefFromGrilling(
    input: {
      project: ProjectForAi;
      /** The whole current Brief (the template before v1): the base the draft edits. */
      briefMarkdown: string;
      /** Retrieved Project context, without the Brief. */
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
      memory: WorkflowMemory;
      answers: GrillingAnswerForAi[];
    },
    options?: AiCallOptions,
  ): Promise<BriefDraft>;

  /**
   * Up to `count` Feature Suggestions (ticket 0034) that serve the Brief's goals
   * and the Guidelines, fill capability gaps, and repeat neither what exists nor
   * what was dismissed.
   */
  suggestFeatures(
    input: {
      project: ProjectForAi;
      count: number;
      /** Retrieved Project context, the current Brief first (ContextRetriever.forProject). */
      projectContext: ContextBlock[];
      /** Each with its `ref`. */
      guidelines: GuidelineForAi[];
      /** The Project's most recent Decisions, newest first. */
      decisions: ContextBlock[];
      /** Suggestions dismissed before, newest first, with the reasons. */
      dismissed: DismissedSuggestionForAi[];
      /** Titles of the suggestions still waiting for a PO, not to be repeated. */
      pending: string[];
    },
    options?: AiCallOptions,
  ): Promise<FeatureSuggestionDrafts>;

  /** The first Spec of a Feature accepted from a Feature Suggestion. */
  draftSpecFromSuggestion(
    input: {
      project: ProjectForAi;
      suggestion: SuggestionForAi;
      /** Retrieved Project context, the current Brief first. */
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ): Promise<SpecProposalDraft>;

  /**
   * The complete next Spec with acceptance criteria for one target Platform that isn't QA
   * ready (Coverage, ticket 0051), drafted from the Spec and the Feature's Decisions in the
   * context, as a Spec Proposal a person approves.
   */
  draftAcceptanceCriteria(
    input: {
      feature: FeatureForAi;
      platform: PlatformForAi;
      /** The whole latest Spec: the base the draft edits. */
      specMarkdown: string;
      /** Retrieved Feature context (its Decisions and requests first), without its Spec. */
      context: ContextBlock[];
    },
    options?: AiCallOptions,
  ): Promise<SpecProposalDraft>;

  /**
   * A Design Doc (ticket 0069) drafted from the approved Spec and the Feature's Decisions: the
   * first version, or (with `current` and `specChange`) the update a new Spec Version needs.
   * What the design needs that they leave open comes back as `questions`.
   */
  draftDesignDoc(
    input: {
      feature: FeatureForAi;
      doc: DesignDocForAi;
      /** The Spec Version it is drafted from. */
      specVersion: number;
      /** What the Design Doc covers of that Spec (`designDocScope`). */
      specMarkdown: string;
      /** The approved Design Doc an update starts from; null for the first draft. */
      current: string | null;
      /** For an update, the lines of what the Spec changed in its scope ("- " removed, "+ " added). */
      specChange: string | null;
      /** The titles of the questions earlier drafts already raised. */
      asked: string[];
      /** Retrieved Feature context (its Decisions and requests first), without its Spec. */
      context: ContextBlock[];
    },
    options?: AiCallOptions,
  ): Promise<DesignDocDraft>;

  /** A Redraft of a Design Doc proposal from a person's feedback (tickets 0065, 0069). */
  redraftDesignDoc(
    input: RedraftFeedbackForAi & {
      feature: FeatureForAi;
      doc: DesignDocForAi;
      specVersion: number;
      specMarkdown: string;
      /** The current Redraft. */
      proposedMarkdown: string;
      context: ContextBlock[];
    },
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown>;

  /** A Redraft of a Decision Request's Choices from a person's feedback (ticket 0065). */
  redraftChoices(
    input: RedraftFeedbackForAi & {
      specMarkdown: string;
      request: RequestForAi;
      /** The current Choices. */
      choices: ChoiceDraft[];
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ): Promise<RedraftedChoices>;

  /** A Redraft of a Spec Proposal: the complete proposed Spec, changed as the feedback asks. */
  redraftSpecProposal(
    input: RedraftFeedbackForAi & {
      feature: FeatureForAi;
      /** The Spec the proposal changes (empty before v1). */
      specMarkdown: string;
      /** The current Redraft's proposed Spec. */
      proposedMarkdown: string;
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown>;

  /** A Redraft of a Brief Proposal: the complete proposed Brief, changed as the feedback asks. */
  redraftBriefProposal(
    input: RedraftFeedbackForAi & {
      project: ProjectForAi;
      /** The Brief the proposal changes (the template before v1). */
      briefMarkdown: string;
      proposedMarkdown: string;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown>;

  /** A Redraft of a Feature Suggestion, changed as the feedback asks. */
  redraftFeatureSuggestion(
    input: RedraftFeedbackForAi & {
      project: ProjectForAi;
      suggestion: SuggestionForAi;
      /** Retrieved Project context, the current Brief first. */
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ): Promise<RedraftedSuggestion>;

  /**
   * The patterns in a prompt's feedback (ticket 0072): what people repeatedly wanted
   * different from what it proposed, each citing the cases that show it.
   */
  analyzeFeedback(
    input: {
      prompt: PromptForAi;
      /** The prompt's active version, as written. */
      template: string;
      /** How many calls of it the outcomes come from, as a line for the prompt. */
      calls: number;
      /** Oldest first. */
      cases: FeedbackCaseForAi[];
    },
    options?: AiCallOptions,
  ): Promise<FeedbackAnalysis>;

  /** A new Prompt Version of a prompt that addresses the patterns, with its rationale. */
  proposePromptVersion(
    input: {
      prompt: PromptForAi;
      /** The active version, as written: the proposal starts from it. */
      template: string;
      /** The `{{placeholders}}` it must keep. */
      placeholders: string[];
      patterns: PatternForAi[];
    },
    options?: AiCallOptions,
  ): Promise<ProposedPromptVersion>;

  /** A Redraft of a proposed Prompt Version from an Admin's feedback (tickets 0065, 0072). */
  redraftPromptVersion(
    input: RedraftFeedbackForAi & {
      prompt: PromptForAi;
      /** The current Redraft's template and rationale. */
      template: string;
      rationale: string;
      /** The version active now, as written. */
      active: string;
      placeholders: string[];
      patterns: PatternForAi[];
    },
    options?: AiCallOptions,
  ): Promise<RedraftedPromptVersion>;

  /** How a Feature about to be created meets each effective Guideline (each with its `ref`). */
  checkFeatureFit(
    input: {
      project: ProjectForAi;
      feature: FeatureForAi;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ): Promise<FeatureFitDraft>;
}

/**
 * The provider refused a request as longer than the model's window (ticket 0060).
 * A Conversation then compacts at once and retries one time.
 */
export class ContextTooLongError extends Error {
  constructor(cause?: unknown) {
    super('The request is longer than the model can read', { cause });
    this.name = 'ContextTooLongError';
  }
}

/**
 * How providers word a too-long request: Anthropic, OpenAI, OpenAI-compatible servers,
 * and Gemini ("The input token count (…) exceeds the maximum number of tokens allowed").
 */
const TOO_LONG =
  /prompt is too long|context[_ ]length|context window|maximum context|too many (input )?tokens|input is too long|exceeds? the (model'?s? )?(maximum|max) (input|context)|exceeds the maximum number of tokens/i;

/** Whether `error` (or one of its causes) says the request was too long for the model. */
export function isContextTooLong(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ContextTooLongError) return true;
    const e = current as {
      message?: unknown;
      code?: unknown;
      responseBody?: unknown;
      cause?: unknown;
    };
    if (e.code === 'context_length_exceeded') return true;
    for (const text of [e.message, e.responseBody]) {
      if (typeof text === 'string' && TOO_LONG.test(text)) return true;
    }
    current = e.cause;
  }
  return typeof error === 'string' && TOO_LONG.test(error);
}

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
