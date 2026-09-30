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

export type FeatureForAi = { title: string; description: string };

export const AttachmentSummary = z.object({
  summary: z.string().trim().min(1),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;

export interface AiPort {
  generateChoices(input: {
    specMarkdown: string;
    request: RequestForAi;
    attachments: AttachmentForAi[];
  }): Promise<GeneratedChoices>;

  draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
    attachments: AttachmentForAi[];
  }): Promise<SpecProposalDraft>;

  summarizeAttachment(input: { attachment: AttachmentForAi }): Promise<AttachmentSummary>;

  /** A complete Spec drafted from the Feature's Attachments (and the current Spec, if any). */
  draftSpecFromAttachments(input: {
    feature: FeatureForAi;
    specMarkdown: string;
    attachments: AttachmentForAi[];
  }): Promise<SpecProposalDraft>;
}

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
