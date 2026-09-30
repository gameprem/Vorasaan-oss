import { ChoiceDraft, ChoiceDrafts, DecisionRequestKind, TeamRole } from '@vorasaan/shared';
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

export interface AiPort {
  generateChoices(input: {
    specMarkdown: string;
    request: RequestForAi;
  }): Promise<GeneratedChoices>;

  draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
  }): Promise<SpecProposalDraft>;
}

export class AiOutputError extends Error {
  constructor(task: string, cause: unknown) {
    super(`The AI returned an invalid result for "${task}" twice`, { cause });
    this.name = 'AiOutputError';
  }
}
