import type {
  AiPort,
  AttachmentForAi,
  ContextBlock,
  DecisionForAi,
  FeatureForAi,
  RequestForAi,
} from './ai.port.ts';
import { describeDecision } from './prompts.ts';

/** Deterministic stand-in for tests. Records calls so tests can assert on them. */
export class FakeAiPort implements AiPort {
  readonly calls: { method: keyof AiPort; input: unknown }[] = [];

  async generateChoices(input: {
    specMarkdown: string;
    request: RequestForAi;
    context: ContextBlock[];
  }) {
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
    context: ContextBlock[];
  }) {
    this.calls.push({ method: 'draftSpecProposal', input });
    return {
      proposedMarkdown: `${input.specMarkdown.trimEnd()}\n\n## Decisions\n- ${input.request.title}: ${describeDecision(input.decision).split('\n')[0]}\n`,
      summary: `Recorded the decision on "${input.request.title}".`,
    };
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }) {
    this.calls.push({ method: 'summarizeAttachment', input });
    const firstLine = input.attachment.text.trim().split('\n')[0] ?? '';
    return { summary: `Summary of "${input.attachment.title}": ${firstLine.slice(0, 80)}` };
  }

  async draftSpecFromAttachments(input: {
    feature: FeatureForAi;
    specMarkdown: string;
    context: ContextBlock[];
  }) {
    this.calls.push({ method: 'draftSpecFromAttachments', input });
    const titles = new Set(
      input.context.filter((b) => b.source.kind === 'ATTACHMENT').map((b) => b.source.title),
    );
    const sources = [...titles].map((title) => `- ${title}`).join('\n');
    return {
      proposedMarkdown: `# ${input.feature.title}\n\n## Sources\n${sources}\n`,
      summary: `Drafted from ${titles.size} Attachments.`,
    };
  }
}
