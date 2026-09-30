import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import type {
  AiPort,
  AttachmentForAi,
  ContextBlock,
  DecisionForAi,
  FeatureForAi,
  GrillingAnswerForAi,
  GuidelineForAi,
  ProjectForAi,
  RequestForAi,
} from './ai.port.ts';
import { describeDecision } from './prompts.ts';
import type { WorkflowMemory } from './workflow-memory.ts';

/**
 * The fake's Grilling questions: one per topic, asked only when no context block
 * mentions the topic's keyword, so a Project whose material covers a round gets
 * fewer questions (as the real prompt asks).
 */
export const FAKE_GRILLING_TOPICS: Record<
  GrillingRoundKind,
  { keyword: string; question: string }[]
> = {
  BUSINESS: [
    { keyword: 'business goal', question: 'What business goals should this Project serve?' },
    { keyword: 'kpi', question: 'Which KPIs tell you it is working?' },
    { keyword: 'target user', question: 'Who are the target users?' },
    { keyword: 'non-goal', question: 'What is deliberately out of scope (non-goals)?' },
  ],
  UX: [
    { keyword: 'user journey', question: 'What are the main user journeys?' },
    { keyword: 'platform', question: 'Which platforms and devices must it support?' },
    { keyword: 'accessibility', question: 'What accessibility needs must it meet?' },
  ],
  TECHNICAL: [
    { keyword: 'architecture', question: 'What does the current architecture look like?' },
    { keyword: 'integration', question: 'Which systems does it integrate with?' },
    { keyword: 'performance', question: 'What performance targets must it meet?' },
  ],
};

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

  async grillingQuestions(input: {
    project: ProjectForAi;
    round: GrillingRoundKind;
    role: TeamRole;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    memory: WorkflowMemory;
  }) {
    this.calls.push({ method: 'grillingQuestions', input });
    const known = input.projectContext.map((b) => b.text.toLowerCase()).join('\n');
    return {
      questions: FAKE_GRILLING_TOPICS[input.round]
        .filter((t) => !known.includes(t.keyword))
        .map((t) => t.question),
    };
  }

  async draftBriefFromGrilling(input: {
    project: ProjectForAi;
    briefMarkdown: string;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    memory: WorkflowMemory;
    answers: GrillingAnswerForAi[];
  }) {
    this.calls.push({ method: 'draftBriefFromGrilling', input });
    const answers = input.answers.map((a) => `- ${a.question} ${a.answer}`).join('\n');
    return {
      proposedMarkdown: `# Project Brief\n\n${input.project.name}\n\n## From Grilling\n${answers}\n`,
      summary: `Drafted from ${input.answers.length} answers.`,
    };
  }
}
