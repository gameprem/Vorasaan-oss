import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import type {
  AiCallOptions,
  AiPort,
  AttachmentForAi,
  ChatChunk,
  ChatMessageForAi,
  ChatTool,
  ContextBlock,
  ConversationScopeForAi,
  DecisionForAi,
  DismissedSuggestionForAi,
  FeatureFitDraft,
  FeatureForAi,
  FeatureSuggestionDrafts,
  GrillingAnswerForAi,
  GrillingFollowUpDecision,
  GrillingFollowUpForAi,
  GuidelineForAi,
  ModelChoice,
  ProjectForAi,
  ProjectFoundationForAi,
  RequestForAi,
  SuggestionForAi,
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

/**
 * One scripted chat reply: its chunks (text pieces and tool calls), streamed in
 * order, then `error` thrown if given (a provider failing mid-reply).
 * `chunkDelayMs` waits before each chunk, so a test can stop a reply mid-stream.
 */
export type ScriptedChatReply = { chunks?: ChatChunk[]; error?: Error; chunkDelayMs?: number };

/** Waits `ms`, or less when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The fake's default reply: it names the scope, echoes the latest message and counts the context. */
export function fakeChatReply(input: {
  scope: ConversationScopeForAi;
  context: ContextBlock[];
  recentMessages: ChatMessageForAi[];
}): string {
  const latest = input.recentMessages.findLast((m) => m.role === 'USER')?.content ?? '';
  const about =
    input.scope.kind === 'FEATURE'
      ? `the Feature "${input.scope.feature.title}"`
      : `the Project "${input.scope.project.name}"`;
  return `About ${about}: you said "${latest.slice(0, 80)}". I read ${input.context.length} context blocks.`;
}

/** The fake asks a follow-up when the latest reply has fewer words than this. */
export const FAKE_THIN_ANSWER_WORDS = 4;

/** The fake's follow-up on a thin answer to `question`. */
export function fakeFollowUp(question: string, asked: number): string {
  return `Follow-up ${asked + 1}: can you say more about "${question}"?`;
}

/** Deterministic stand-in for tests. Records calls so tests can assert on them. */
export class FakeAiPort implements AiPort {
  /** Every call, with the model it was asked to run on (null when none was chosen). */
  readonly calls: { method: keyof AiPort; input: unknown; model: ModelChoice | null }[] = [];
  /** Replies the next chat calls give, in order, instead of the default one. */
  readonly chatScript: ScriptedChatReply[] = [];

  /**
   * Decisions the next grillingFollowUp calls return, in order, instead of the
   * default: a follow-up's text, null to move on, or an Error to throw.
   */
  readonly followUpScript: (string | null | Error)[] = [];

  /** Queues follow-up decisions, e.g. "always ask one" to test the server's limit. */
  scriptGrillingFollowUps(...decisions: (string | null | Error)[]): this {
    this.followUpScript.push(...decisions);
    return this;
  }

  /** Queues replies for the next chat calls, e.g. a tool call or a failure mid-stream. */
  scriptChat(...replies: ScriptedChatReply[]): this {
    this.chatScript.push(...replies);
    return this;
  }

  /** Streams the next scripted reply, or else `fakeChatReply` word by word. */
  async *chat(
    input: {
      scope: ConversationScopeForAi;
      context: ContextBlock[];
      foundation: ProjectFoundationForAi;
      summary: string;
      recentMessages: ChatMessageForAi[];
      tools: ChatTool[];
      signal?: AbortSignal;
    },
    options?: AiCallOptions,
  ): AsyncIterable<ChatChunk> {
    this.calls.push({ method: 'chat', input, model: options?.model ?? null });
    const scripted = this.chatScript.shift();
    const chunks: ChatChunk[] = scripted
      ? (scripted.chunks ?? [])
      : (fakeChatReply(input).match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text', delta }));
    for (const chunk of chunks) {
      // A real stream yields between chunks; so does the fake, so listeners see each one.
      if (scripted?.chunkDelayMs) await pause(scripted.chunkDelayMs, input.signal);
      else await Promise.resolve();
      // Like a provider's stream, a stopped reply ends with an AbortError.
      if (input.signal?.aborted) throw new DOMException('The reply was stopped', 'AbortError');
      yield chunk;
    }
    if (scripted?.error) throw scripted.error;
  }

  /** The old summary, then one line per folded message. */
  async summarizeConversation(
    input: {
      scope: ConversationScopeForAi;
      summary: string;
      messages: ChatMessageForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'summarizeConversation', input, model: options?.model ?? null });
    const lines = input.messages.map((m) => `${m.role}: ${m.content.slice(0, 60)}`);
    return { summary: [input.summary, ...lines].filter(Boolean).join('\n') };
  }

  async generateChoices(
    input: {
      specMarkdown: string;
      request: RequestForAi;
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'generateChoices', input, model: options?.model ?? null });
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

  async draftSpecProposal(
    input: {
      specMarkdown: string;
      request: RequestForAi;
      decision: DecisionForAi;
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'draftSpecProposal', input, model: options?.model ?? null });
    return {
      proposedMarkdown: `${input.specMarkdown.trimEnd()}\n\n## Decisions\n- ${input.request.title}: ${describeDecision(input.decision).split('\n')[0]}\n`,
      summary: `Recorded the decision on "${input.request.title}".`,
    };
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }, options?: AiCallOptions) {
    this.calls.push({ method: 'summarizeAttachment', input, model: options?.model ?? null });
    const firstLine = input.attachment.text.trim().split('\n')[0] ?? '';
    return { summary: `Summary of "${input.attachment.title}": ${firstLine.slice(0, 80)}` };
  }

  async draftSpecFromAttachments(
    input: {
      feature: FeatureForAi;
      specMarkdown: string;
      context: ContextBlock[];
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'draftSpecFromAttachments', input, model: options?.model ?? null });
    const titles = new Set(
      input.context.filter((b) => b.source.kind === 'ATTACHMENT').map((b) => b.source.title),
    );
    const sources = [...titles].map((title) => `- ${title}`).join('\n');
    return {
      proposedMarkdown: `# ${input.feature.title}\n\n## Sources\n${sources}\n`,
      summary: `Drafted from ${titles.size} Attachments.`,
    };
  }

  async grillingQuestions(
    input: {
      project: ProjectForAi;
      round: GrillingRoundKind;
      role: TeamRole;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
      memory: WorkflowMemory;
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'grillingQuestions', input, model: options?.model ?? null });
    const known = input.projectContext.map((b) => b.text.toLowerCase()).join('\n');
    return {
      questions: FAKE_GRILLING_TOPICS[input.round]
        .filter((t) => !known.includes(t.keyword))
        .map((t) => t.question),
    };
  }

  /**
   * The next scripted decision, else a follow-up when the latest reply (the
   * last follow-up's, or the answer) has fewer than FAKE_THIN_ANSWER_WORDS words.
   */
  async grillingFollowUp(
    input: {
      project: ProjectForAi;
      round: GrillingRoundKind;
      role: TeamRole;
      question: string;
      answer: string;
      followUps: GrillingFollowUpForAi[];
      remaining: number;
    },
    options?: AiCallOptions,
  ): Promise<GrillingFollowUpDecision> {
    this.calls.push({ method: 'grillingFollowUp', input, model: options?.model ?? null });
    if (this.followUpScript.length) {
      const scripted = this.followUpScript.shift() ?? null;
      if (scripted instanceof Error) throw scripted;
      return { followUp: scripted };
    }
    const latest = input.followUps.at(-1)?.answer ?? input.answer;
    const words = latest.trim().split(/\s+/).filter(Boolean).length;
    return {
      followUp:
        words < FAKE_THIN_ANSWER_WORDS
          ? fakeFollowUp(input.question, input.followUps.length)
          : null,
    };
  }

  async draftBriefFromGrilling(
    input: {
      project: ProjectForAi;
      briefMarkdown: string;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
      memory: WorkflowMemory;
      answers: GrillingAnswerForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'draftBriefFromGrilling', input, model: options?.model ?? null });
    const answers = input.answers
      .map((a) => {
        const by = a.answeredBy ? ` (${a.answeredBy.name}, ${a.answeredBy.role})` : '';
        const more = a.followUps.map((f) => ` / ${f.question} ${f.answer}`).join('');
        return `- ${a.question} ${a.answer}${more}${by}`;
      })
      .join('\n');
    return {
      proposedMarkdown: `# Project Brief\n\n${input.project.name}\n\n## From Grilling\n${answers}\n`,
      summary: `Drafted from ${input.answers.length} answers.`,
    };
  }

  /**
   * `count` suggestions titled "Suggested Feature N", skipping any title already
   * pending or dismissed, each serving every Guideline, plus one unknown ref the
   * server must drop.
   */
  async suggestFeatures(
    input: {
      project: ProjectForAi;
      count: number;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
      decisions: ContextBlock[];
      dismissed: DismissedSuggestionForAi[];
      pending: string[];
    },
    options?: AiCallOptions,
  ): Promise<FeatureSuggestionDrafts> {
    this.calls.push({ method: 'suggestFeatures', input, model: options?.model ?? null });
    const taken = new Set([...input.pending, ...input.dismissed.map((d) => d.title)]);
    const suggestions: FeatureSuggestionDrafts['suggestions'] = [];
    for (let n = 1; suggestions.length < input.count; n++) {
      const title = `Suggested Feature ${n}`;
      if (taken.has(title)) continue;
      suggestions.push({
        title,
        rationale: `Fills gap ${n} of ${input.project.name}.`,
        businessValue: `Moves goal ${n}.`,
        effort: 'MEDIUM',
        risk: 'LOW',
        servesGuidelines: [...input.guidelines.flatMap((g) => (g.ref ? [g.ref] : [])), 'G999'],
      });
    }
    return { suggestions };
  }

  async draftSpecFromSuggestion(
    input: {
      project: ProjectForAi;
      suggestion: SuggestionForAi;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.calls.push({ method: 'draftSpecFromSuggestion', input, model: options?.model ?? null });
    return {
      proposedMarkdown: `# ${input.suggestion.title}\n\n${input.suggestion.rationale}\n\n## Business value\n${input.suggestion.businessValue}\n`,
      summary: `First Spec of "${input.suggestion.title}".`,
    };
  }

  /**
   * MET when the description mentions the Guideline's title, else UNCLEAR with a
   * question; the last Guideline is left out (the server must fill it in).
   */
  async checkFeatureFit(
    input: {
      project: ProjectForAi;
      feature: FeatureForAi;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ): Promise<FeatureFitDraft> {
    this.calls.push({ method: 'checkFeatureFit', input, model: options?.model ?? null });
    const text = `${input.feature.title}\n${input.feature.description}`.toLowerCase();
    return {
      results: input.guidelines.slice(0, -1).map((g) => {
        const met = text.includes(g.title.toLowerCase());
        return {
          guideline: g.ref ?? '',
          verdict: met ? ('MET' as const) : ('UNCLEAR' as const),
          reason: met ? `Mentions "${g.title}".` : `Doesn't say how it meets "${g.title}".`,
          question: met ? null : `How does it meet "${g.title}"?`,
        };
      }),
    };
  }
}
