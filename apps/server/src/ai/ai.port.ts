import {
  AttachmentSource,
  ChoiceDraft,
  ChoiceDrafts,
  DecisionRequestKind,
  type GrillingRoundKind,
  GuidelineCriterionKind,
  GuidelineFitVerdict,
  MAX_GRILLING_QUESTIONS,
  SuggestionLevel,
  TeamRole,
} from '@vorasaan/shared';
import { z } from 'zod';
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

/** What a chat reply streams: pieces of its text, and the tools it calls. */
export type ChatChunk = { type: 'text'; delta: string } | { type: 'tool-call'; call: ChatToolCall };

export const ConversationSummaryDraft = z.object({
  summary: z.string().trim().min(1),
});
export type ConversationSummaryDraft = z.infer<typeof ConversationSummaryDraft>;

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
};

/**
 * Per-call options every AiPort method takes.
 * - `approvedModelId`: the caller picks the model (the chat picker, 0054). An
 *   unknown one falls back to the task's model.
 * - `model`: the resolved model, filled in by `ModelRoutingAiPort` before the call
 *   reaches the provider adapter (or the fake). A caller that chose it already
 *   (`AiSettingsService.chooseModel`) passes it, and it is kept as is: a
 *   Conversation's turn chooses once, so all its steps run on one model (0054).
 */
export type AiCallOptions = { approvedModelId?: string; model?: ModelChoice };

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
      signal?: AbortSignal;
    },
    options?: AiCallOptions,
  ): AsyncIterable<ChatChunk>;

  /** The Conversation's summary with `messages` (the oldest not yet in it) folded in. */
  summarizeConversation(
    input: {
      scope: ConversationScopeForAi;
      summary: string;
      messages: ChatMessageForAi[];
    },
    options?: AiCallOptions,
  ): Promise<ConversationSummaryDraft>;

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

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
