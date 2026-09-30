import type { AiPort, DecisionForAi, RequestForAi } from './ai.port.ts';
import { describeDecision } from './prompts.ts';

/** Deterministic stand-in for tests. Records calls so tests can assert on them. */
export class FakeAiPort implements AiPort {
  readonly calls: { method: keyof AiPort; input: unknown }[] = [];

  async generateChoices(input: { specMarkdown: string; request: RequestForAi }) {
    this.calls.push({ method: 'generateChoices', input });
    return {
      suggestedRole: 'PO' as const,
      choices: ['A', 'B', 'C'].map((label, i) => ({
        label,
        title: `Option ${label} for "${input.request.title}"`,
        description: `Fake option ${i + 1}.`,
        impactScope: `Scope ${label}`,
        impactTime: `+${i + 1} days`,
        impactRisk: `Risk ${label}`,
      })),
    };
  }

  async draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
  }) {
    this.calls.push({ method: 'draftSpecProposal', input });
    return {
      proposedMarkdown: `${input.specMarkdown.trimEnd()}\n\n## Decisions\n- ${input.request.title}: ${describeDecision(input.decision).split('\n')[0]}\n`,
      summary: `Recorded the decision on "${input.request.title}".`,
    };
  }
}
