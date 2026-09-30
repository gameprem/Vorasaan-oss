import {
  AttachmentSource,
  ChoiceDraft,
  ChoiceDrafts,
  DecisionRequestKind,
  type GrillingRoundKind,
  GuidelineCriterionKind,
  MAX_GRILLING_QUESTIONS,
  TeamRole,
} from '@vorasaan/shared';
import { z } from 'zod';
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
  title: string;
  description: string;
  kind: GuidelineCriterionKind;
  required: boolean;
};

/** One answered Grilling question. `answer` is a person's own words: untrusted. */
export type GrillingAnswerForAi = { round: GrillingRoundKind; question: string; answer: string };

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

export interface AiPort {
  generateChoices(input: {
    specMarkdown: string;
    request: RequestForAi;
    /** Retrieved context, most important first, without the Feature's own Spec. */
    context: ContextBlock[];
  }): Promise<GeneratedChoices>;

  draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
    context: ContextBlock[];
  }): Promise<SpecProposalDraft>;

  summarizeAttachment(input: { attachment: AttachmentForAi }): Promise<AttachmentSummary>;

  /** A complete Spec drafted from the Feature's Attachments (and the current Spec, if any). */
  draftSpecFromAttachments(input: {
    feature: FeatureForAi;
    specMarkdown: string;
    context: ContextBlock[];
  }): Promise<SpecProposalDraft>;

  /**
   * The questions of one Grilling round (ticket 0032), only about what the
   * Project context and the earlier rounds leave unanswered.
   */
  grillingQuestions(input: {
    project: ProjectForAi;
    round: GrillingRoundKind;
    role: TeamRole;
    /** Retrieved Project context, the current Brief first (ContextRetriever.forProject). */
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    /** Summaries of the rounds already done. */
    memory: WorkflowMemory;
  }): Promise<GrillingQuestionDrafts>;

  /** The complete next Project Brief, from every Grilling answer and the Project context. */
  draftBriefFromGrilling(input: {
    project: ProjectForAi;
    /** The whole current Brief (the template before v1): the base the draft edits. */
    briefMarkdown: string;
    /** Retrieved Project context, without the Brief. */
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    memory: WorkflowMemory;
    answers: GrillingAnswerForAi[];
  }): Promise<BriefDraft>;
}

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
