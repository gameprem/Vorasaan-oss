import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import type {
  ActionCardForAi,
  AiCallOptions,
  AiPort,
  AttachmentForAi,
  CallUsage,
  ChatChunk,
  ChatMessageForAi,
  ChatTool,
  ContextBlock,
  ConversationFoldDraft,
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
  RecordForAi,
  RedraftedChoices,
  RedraftedMarkdown,
  RedraftedSuggestion,
  RedraftFeedbackForAi,
  RequestForAi,
  SuggestionForAi,
} from './ai.port.ts';
import { toolTokens } from './context-budget.ts';
import type { ReplyLanguage } from './language.ts';
import { chatPrompt, describeDecision, SUMMARY_SECTIONS } from './prompts.ts';
import { estimateChatTokens } from './token-count.ts';
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

/**
 * What a chat call's whole prompt costs, measured the way the fake counts: the
 * rendered instructions (Brief, Guidelines, context, summary), the tools and the
 * messages, by the script-aware estimate. Tests check budgets against it.
 */
export async function chatPromptTokens(input: {
  scope: ConversationScopeForAi;
  context: ContextBlock[];
  foundation: ProjectFoundationForAi;
  summary: string;
  recentMessages: ChatMessageForAi[];
  tools: ChatTool[];
}): Promise<number> {
  return (
    estimateChatTokens({ system: (await chatPrompt(input)).text, messages: input.recentMessages }) +
    toolTokens(input.tools)
  );
}

/** Words that mark an agreement, in English and Thai, for the fake's Conversation Summary. */
const AGREED = /\b(agreed?|we will|decided|let's go with)\b|ตกลง|เห็นด้วย|สรุปว่า|ใช้แบบ/i;
/** What the fake keeps as names, numbers and ids: ticket keys, ids, amounts with units. */
const KEY_FACT =
  /\b[A-Z][A-Z0-9]+-\d+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** The items of one section of a rendered Conversation Summary (the fake carries them over). */
function summarySection(summary: string, heading: string): string[] {
  const at = summary.indexOf(`## ${heading}\n`);
  if (at < 0) return [];
  const body = summary.slice(at + heading.length + 4).split('\n## ')[0] ?? '';
  return body
    .split('\n')
    .filter((l) => l.startsWith('- ') && l !== '- (none)')
    .map((l) => l.slice(2));
}

/**
 * What the fake takes as a stated preference in feedback (ticket 0065): clauses about the
 * language, length or tone, in English and Thai. Anything else is a change to the content.
 */
const PREFERENCE =
  /\b(in (thai|english)|shorter|longer|brief(er)?|concise|more detail(ed)?|formal|casual|bullet points?)\b|ภาษาไทย|ภาษาอังกฤษ|สั้น|กระชับ|ละเอียด/i;

/** The clauses of feedback that state a preference, as the fake finds them. */
export function fakePreferences(feedback: string): string[] {
  return feedback
    .split(/[,.;\n]+|\band\b/)
    .map((c) => c.trim())
    .filter((c) => c && PREFERENCE.test(c))
    .map((c) => c.slice(0, 300));
}

/** The line the fake's Markdown Redraft adds: the feedback's first line. */
export function fakeRedraftLine(feedback: string): string {
  return `- Changed as asked: ${feedback.split('\n')[0]?.trim().slice(0, 200) ?? ''}`;
}

/** The fake asks a follow-up when the latest reply has fewer words than this. */
export const FAKE_THIN_ANSWER_WORDS = 4;

/** The fake's follow-up on a thin answer to `question`. */
export function fakeFollowUp(question: string, asked: number): string {
  return `Follow-up ${asked + 1}: can you say more about "${question}"?`;
}

/** What the fake reports as one call's usage, unless a test changes `usage`. */
export const FAKE_USAGE: CallUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 800,
  cacheWriteTokens: 150,
};

/** Deterministic stand-in for tests. Records calls so tests can assert on them. */
export class FakeAiPort implements AiPort {
  /** Every call, with the model it was asked to run on (null when none was chosen). */
  readonly calls: {
    method: keyof AiPort;
    input: unknown;
    model: ModelChoice | null;
    /** The reply language the call was asked for (ticket 0068); null when none was given. */
    language: ReplyLanguage | null;
  }[] = [];
  /** Replies the next chat calls give, in order, instead of the default one. */
  readonly chatScript: ScriptedChatReply[] = [];
  /** Every countTokens call, with what it counted (kept apart from `calls`). */
  readonly tokenCounts: {
    input: { system: string; messages: ChatMessageForAi[] };
    tokens: number;
  }[] = [];
  /** The fake's counter is the estimate times this: above 1 plays a denser tokenizer. */
  tokenScale = 1;
  /**
   * What each chat step reports as read from the provider's cache (ticket 0066); its
   * input is the prompt by the fake's counter. Null reports no usage at all.
   */
  cacheReadTokens: number | null = 0;

  /**
   * What every call but chat reports as its usage (ticket 0070), for its Receipt; null
   * reports none. Chat reports its prompt by the fake's counter, as for the meter.
   */
  usage: CallUsage | null = { ...FAKE_USAGE };

  /** Errors the next calls (of any method but chat) throw, in order, after being recorded. */
  readonly failures: Error[] = [];

  /** Records a call and reports its usage; throws the next queued failure, if any. */
  private record(method: keyof AiPort, input: unknown, options: AiCallOptions | undefined) {
    this.calls.push({
      method,
      input,
      model: options?.model ?? null,
      language: options?.language ?? null,
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (this.usage) options?.onUsage?.({ ...this.usage });
  }

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
    // Not `record`: a chat reply's usage is reported with its last chunk, below.
    this.calls.push({
      method: 'chat',
      input,
      model: options?.model ?? null,
      language: options?.language ?? null,
    });
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
    if (this.cacheReadTokens !== null) {
      const inputTokens = Math.ceil((await chatPromptTokens(input)) * this.tokenScale);
      const cacheReadTokens = Math.min(inputTokens, this.cacheReadTokens);
      const outputTokens = chunks.filter((c) => c.type === 'text').length;
      options?.onUsage?.({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });
      yield {
        type: 'usage',
        usage: { inputTokens, cacheReadTokens: Math.min(inputTokens, this.cacheReadTokens) },
      };
    }
  }

  /** The script-aware estimate (ticket 0059) times `tokenScale`: deterministic. */
  async countTokens(input: { system: string; messages: ChatMessageForAi[] }) {
    const tokens = Math.ceil(estimateChatTokens(input) * this.tokenScale);
    this.tokenCounts.push({ input, tokens });
    return tokens;
  }

  /**
   * A deterministic Conversation Summary: the sections so far carried over; the
   * goal from the first message; every line that agrees ("agreed", "ตกลง"...) in
   * Agreed; questions in Open questions; the PROPOSED Action Cards; ticket keys
   * and ids in Names, numbers and ids; and one short line per folded message.
   */
  async summarizeConversation(
    input: {
      scope: ConversationScopeForAi;
      summary: string;
      messages: ChatMessageForAi[];
      actionCards: ActionCardForAi[];
      focus?: string | null;
      record?: RecordForAi | null;
    },
    options?: AiCallOptions,
  ): Promise<ConversationFoldDraft> {
    this.record('summarizeConversation', input, options);
    const before = (key: (typeof SUMMARY_SECTIONS)[number][0]) =>
      summarySection(input.summary, SUMMARY_SECTIONS.find(([k]) => k === key)?.[1] ?? '');
    const lines = input.messages.flatMap((m) =>
      m.content
        .split(/\n+|(?<=[.!?])\s+/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const firstUser = input.messages.find((m) => m.role === 'USER')?.content ?? '';
    const personLines = input.messages
      .filter((m) => m.role === 'USER')
      .flatMap((m) => m.content.split(/\n+|(?<=[.!?])\s+/).map((l) => l.trim()))
      .filter(Boolean);
    const unique = (items: string[]) => [...new Set(items)];
    const agreed = unique([...before('agreed'), ...lines.filter((l) => AGREED.test(l))]).map((l) =>
      l.slice(0, 300),
    );
    // The focus is kept word for word, as the person asked (ticket 0066).
    const focus = input.focus?.trim();
    const recorded = input.record?.markdown.toLowerCase() ?? '';
    return {
      goal: before('goal')[0] ?? firstUser.slice(0, 120),
      agreed,
      // The person's own agreed lines, unless the Spec or Brief holds them word for word.
      unrecorded: input.record
        ? unique(personLines.filter((l) => AGREED.test(l)))
            .map((l) => l.slice(0, 300))
            .filter((l) => !recorded.includes(l.toLowerCase().replace(/[.!]+$/, '')))
        : [],
      openQuestions: unique([
        ...before('openQuestions'),
        ...lines.filter((l) => l.endsWith('?')).map((l) => l.slice(0, 300)),
      ]),
      pendingActionCards: input.actionCards
        .filter((c) => c.status === 'PROPOSED')
        .map((c) => `${c.kind}: ${c.title}`),
      preferences: unique([...before('preferences'), ...(focus ? [`Keep: ${focus}`] : [])]),
      keyFacts: unique([
        ...before('keyFacts'),
        ...input.messages.flatMap((m) => m.content.match(KEY_FACT) ?? []),
        ...input.messages.map((m) => `${m.role}: ${m.content.slice(0, 60)}`),
      ]),
    };
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
    this.record('generateChoices', input, options);
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
    this.record('draftSpecProposal', input, options);
    return {
      proposedMarkdown: `${input.specMarkdown.trimEnd()}\n\n## Decisions\n- ${input.request.title}: ${describeDecision(input.decision).split('\n')[0]}\n`,
      summary: `Recorded the decision on "${input.request.title}".`,
    };
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }, options?: AiCallOptions) {
    this.record('summarizeAttachment', input, options);
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
    this.record('draftSpecFromAttachments', input, options);
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
    this.record('grillingQuestions', input, options);
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
    this.record('grillingFollowUp', input, options);
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
    this.record('draftBriefFromGrilling', input, options);
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
    this.record('suggestFeatures', input, options);
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
    this.record('draftSpecFromSuggestion', input, options);
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
    this.record('checkFeatureFit', input, options);
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

  /**
   * Thrown by the next redraft calls, in order, instead of answering (ticket 0065), to
   * test a failed Redraft. A Promise in the queue is awaited first (to hold one open).
   */
  readonly redraftScript: (Error | Promise<unknown>)[] = [];

  private async nextRedraft(): Promise<void> {
    const next = this.redraftScript.shift();
    if (next instanceof Error) throw next;
    if (next) await next;
  }

  /**
   * The current Choices, with the pointed-at Choice (or else the first) retitled
   * "<title> (redraft N)" and its description ending in the feedback.
   */
  async redraftChoices(
    input: Parameters<AiPort['redraftChoices']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedChoices> {
    this.record('redraftChoices', input, options);
    await this.nextRedraft();
    const n = input.current + 1;
    const pointed = input.feedback.pointer?.match(/^Choice ([A-D])\b/)?.[1];
    const target = pointed ?? input.choices[0]?.label;
    return {
      choices: input.choices.map((c) =>
        c.label === target
          ? {
              ...c,
              title: `${c.title.replace(/ \(redraft \d+\)$/, '')} (redraft ${n})`.slice(0, 200),
              description: `${c.description} ${input.feedback.feedback.split('\n')[0]}`.trim(),
            }
          : c,
      ),
      summary: `Redraft ${n}: changed Choice ${target}.`,
      preferences: fakePreferences(input.feedback.feedback),
    };
  }

  /** The current Redraft with one line added: "- Changed as asked: <feedback>". */
  async redraftSpecProposal(
    input: Parameters<AiPort['redraftSpecProposal']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown> {
    this.record('redraftSpecProposal', input, options);
    await this.nextRedraft();
    return fakeMarkdownRedraft(input, input.proposedMarkdown);
  }

  async redraftBriefProposal(
    input: Parameters<AiPort['redraftBriefProposal']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown> {
    this.record('redraftBriefProposal', input, options);
    await this.nextRedraft();
    return fakeMarkdownRedraft(input, input.proposedMarkdown);
  }

  /** The suggestion with its rationale ending in the feedback. */
  async redraftFeatureSuggestion(
    input: Parameters<AiPort['redraftFeatureSuggestion']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedSuggestion> {
    this.record('redraftFeatureSuggestion', input, options);
    await this.nextRedraft();
    const n = input.current + 1;
    return {
      ...input.suggestion,
      rationale: `${input.suggestion.rationale} ${input.feedback.feedback.split('\n')[0]}`.trim(),
      summary: `Redraft ${n} of "${input.suggestion.title}".`,
      preferences: fakePreferences(input.feedback.feedback),
    };
  }
}

function fakeMarkdownRedraft(input: RedraftFeedbackForAi, markdown: string): RedraftedMarkdown {
  const n = input.current + 1;
  return {
    proposedMarkdown: `${markdown.trimEnd()}\n${fakeRedraftLine(input.feedback.feedback)}\n`,
    summary: `Redraft ${n}: ${input.feedback.feedback.split('\n')[0]?.slice(0, 80) ?? ''}`,
    preferences: fakePreferences(input.feedback.feedback),
  };
}
