import {
  AttachmentSource,
  ChoiceDraft,
  ChoiceDrafts,
  DecisionRequestKind,
  TeamRole,
} from '@vorasaan/shared';
import { z } from 'zod';

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
  kind: 'SPEC_VERSION' | 'DECISION_REQUEST' | 'DECISION' | 'ATTACHMENT';
  id: string;
  title: string;
  /** The Spec Version number, for Spec blocks. */
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
}

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
