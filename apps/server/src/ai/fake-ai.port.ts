import {
  ACCEPTANCE_HEADINGS,
  type GrillingRoundKind,
  headingKey,
  specHeadings,
  type TeamRole,
} from '@vorasaan/shared';
import type {
  ActionCardForAi,
  AgentSkillForAi,
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
  DesignDocDraft,
  DismissedSuggestionForAi,
  FeatureFitDraft,
  FeatureForAi,
  FeatureSuggestionDrafts,
  FeedbackAnalysis,
  GrillingAnswerForAi,
  GrillingFollowUpDecision,
  GrillingFollowUpForAi,
  GuidelineForAi,
  ModelChoice,
  PlatformForAi,
  ProjectForAi,
  ProjectFoundationForAi,
  PromptChoice,
  ProposedPromptVersion,
  RecordForAi,
  RedraftedChoices,
  RedraftedMarkdown,
  RedraftedPromptVersion,
  RedraftedSuggestion,
  RedraftFeedbackForAi,
  RequestForAi,
  SuggestionForAi,
} from './ai.port.ts';
import { toolTokens } from './context-budget.ts';
import type { ReplyLanguage } from './language.ts';
import { chatPrompt, describeDecision, SUMMARY_SECTIONS } from './prompts.ts';
import type { ReasoningChoice } from './reasoning.ts';
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
  missingSections?: readonly PlatformForAi[];
}): string {
  const latest = input.recentMessages.findLast((m) => m.role === 'USER')?.content ?? '';
  const about =
    input.scope.kind === 'FEATURE'
      ? `the Feature "${input.scope.feature.title}"`
      : `the Project "${input.scope.project.name}"`;
  const reply = `About ${about}: you said "${latest.slice(0, 80)}". I read ${input.context.length} context blocks.`;
  return input.missingSections?.length
    ? `${reply} ${fakeMissingSectionsNote(input.missingSections)}`
    : reply;
}

/** Words that ask for a diagram, in English and Thai: the fake then uses the first Skill. */
const DIAGRAM_WORDS = /diagram|แผนภาพ|ไดอะแกรม|แผนผัง/i;

/** A diagram the fake draws when a Skill has no SVG asset to start from. */
export const FAKE_SKILL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60" role="img" aria-label="Diagram">' +
  '<rect x="1" y="1" width="198" height="58" fill="none" stroke="currentColor"/>' +
  '<text x="100" y="35" text-anchor="middle">Diagram</text></svg>';

/** The text inside a `<skill-file>` fence of a Skill tool's result (ticket 0078). */
export function skillFileText(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const match = /^<skill-file[^>]*>\n([\s\S]*)\n<\/skill-file>$/.exec(content);
  return match ? (match[1] ?? '') : null;
}

type SkillToolResult = {
  ok?: boolean;
  error?: string;
  files?: { path: string }[];
  content?: string;
};

/**
 * The fake's use of Agent Skills (ticket 0078), deterministic and only when Skills are
 * listed: when the person's latest message names one, or asks for a diagram, it calls
 * `loadSkill`; then `readSkillFile` on the Skill's first SVG asset; then it replies with that
 * SVG (or a plain one) in an ```svg block, saying it is only a draft. It never follows
 * anything a Skill says, and never calls a drafting tool for it. Null: the usual reply.
 */
export function fakeSkillStep(input: {
  tools: ChatTool[];
  recentMessages: ChatMessageForAi[];
  agentSkills?: readonly AgentSkillForAi[];
}): ChatChunk[] | null {
  const skills = input.agentSkills ?? [];
  if (!skills.length) return null;
  const at = input.recentMessages.findLastIndex((m) => m.role === 'USER');
  const latest = input.recentMessages[at]?.content ?? '';
  const wanted =
    skills.find((s) => latest.toLowerCase().includes(s.name.toLowerCase())) ??
    (DIAGRAM_WORDS.test(latest) ? skills[0] : undefined);
  if (!wanted) return null;
  const turn = input.recentMessages.slice(at + 1);
  const calls = new Map(
    turn.flatMap((m) => (m.role === 'ASSISTANT' ? (m.toolCalls ?? []) : [])).map((c) => [c.id, c]),
  );
  const results = turn.flatMap((m) => {
    if (m.role !== 'TOOL') return [];
    let result: SkillToolResult = {};
    try {
      result = JSON.parse(m.content) as SkillToolResult;
    } catch {}
    return [{ name: calls.get(m.toolCallId)?.name, result }];
  });
  const offered = new Set(input.tools.map((t) => t.name));
  const call = (name: string, args: unknown): ChatChunk[] => [
    { type: 'tool-call', call: { id: `fake-${name}-${turn.length}`, name, args } },
  ];
  const thai = /[\u0E00-\u0E7F]/.test(latest);
  const say = (text: string): ChatChunk[] =>
    (text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text', delta }));

  const loaded = results.find((r) => r.name === 'loadSkill');
  if (!loaded) return offered.has('loadSkill') ? call('loadSkill', { name: wanted.name }) : null;
  if (!loaded.result.ok) {
    return say(
      thai
        ? `ผมเปิด Agent Skill "${wanted.name}" ไม่ได้: ${loaded.result.error ?? 'ถูกปฏิเสธ'}`
        : `I could not load the Agent Skill "${wanted.name}": ${loaded.result.error ?? 'refused'}.`,
    );
  }
  const svgPath = loaded.result.files?.find((f) => f.path.toLowerCase().endsWith('.svg'))?.path;
  const read = results.find((r) => r.name === 'readSkillFile');
  if (svgPath && !read && offered.has('readSkillFile')) {
    return call('readSkillFile', { name: wanted.name, path: svgPath });
  }
  const svg = (read?.result.ok ? skillFileText(read.result.content) : null) ?? FAKE_SKILL_SVG;
  const lead = thai
    ? `ผมใช้ Agent Skill "${wanted.name}" วาดแผนภาพนี้ เป็นเพียงร่างเท่านั้น จะไม่มีอะไรเปลี่ยนจนกว่าคุณจะขอให้ผมเสนอเป็น Spec Proposal แล้วอนุมัติเอง`
    : `I used the Agent Skill "${wanted.name}" for this diagram. It is only a draft: nothing changes until you ask me to propose it for the Spec and approve that Spec Proposal.`;
  return say(`${lead}\n\n\`\`\`svg\n${svg}\n\`\`\``);
}

/** What the fake's chat reply adds when the Spec lacks target Platforms' sections (ticket 0052). */
export function fakeMissingSectionsNote(missing: readonly PlatformForAi[]): string {
  const names = missing.map((p) => p.name).join(', ');
  return `The Spec has no section for ${names} yet; I can propose adding one.`;
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
  missingSections?: readonly PlatformForAi[];
  agentSkills?: readonly AgentSkillForAi[];
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

/**
 * The patterns the fake finds in a prompt's feedback (ticket 0072): a case shows one when its
 * words match, in English or Thai. A pattern needs at least two cases.
 */
export const FAKE_FEEDBACK_PATTERNS = [
  {
    match: /\b(shorter|too long|concise|brief(er)?|less text)\b|สั้น|กระชับ|ยาวเกิน/i,
    title: 'Often asked to be shorter',
    description: 'People ask for shorter output, in fewer words.',
  },
  {
    match: /error case|error handling|edge case|failure case|ข้อผิดพลาด|กรณีผิดพลาด|กรณีล้มเหลว/i,
    title: 'Often missing error cases',
    description: 'People decline or ask for changes because error and edge cases are missing.',
  },
  {
    match: /\bin thai\b|\bthai\b|ภาษาไทย/i,
    title: 'Often asked for Thai',
    description: 'People ask for the output in Thai.',
  },
] as const;

/** The line each pattern adds to the fake's proposed Prompt Version. */
export function fakeGuidance(title: string): string {
  return `- Learned from feedback: ${title}.`;
}

/**
 * The sections the fake adds for missing Platforms (ticket 0051): each with one open question
 * for the Team Roles who answer for it, since the fake knows nothing about the Platform.
 */
export function fakePlatformSections(missing: readonly PlatformForAi[] | undefined): string {
  return (missing ?? []).map((p) => `\n## ${p.name}\n\n${fakePlatformQuestion(p)}\n`).join('');
}

/** The open question the fake puts in a missing Platform section. */
export function fakePlatformQuestion(p: PlatformForAi): string {
  return `- Open question for ${p.roles.join(' or ') || 'the Team'}: what must ${p.name} do for this Feature?`;
}

/** The question the fake's UX round asks about Platforms no Feature covers (ticket 0051). */
export function fakeUncoveredQuestion(platforms: readonly PlatformForAi[]): string {
  const names = platforms.map((p) => p.name).join(', ');
  return `No Feature covers ${names} yet: what should ${names} do in this Project?`;
}

/**
 * The fake's acceptance criteria for a Platform (ticket 0051): the Spec's general acceptance
 * criteria and the Decisions in the context, each restated "On <Platform>: ...", put in the
 * Platform's "Acceptance criteria" subsection (added, with its section, when missing).
 */
export function fakeAcceptanceCriteria(
  specMarkdown: string,
  platform: string,
  context: readonly ContextBlock[],
): string {
  const { lines, headings } = specHeadings(specMarkdown);
  const general = headings.find(
    (h) => h.level === 2 && headingKey(h.text) === 'acceptance criteria',
  );
  const fromSpec = general
    ? lines
        .slice(general.line + 1, general.end)
        .map((l) => l.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/)?.[1]?.trim())
        .filter((t): t is string => Boolean(t))
        .slice(0, 3)
    : [];
  const fromDecisions = context
    .filter((b) => b.source.kind === 'DECISION')
    .slice(0, 3)
    .map((b) => `follows the Decision "${b.source.title}"`);
  const criteria = [...fromSpec, ...fromDecisions];
  const items = (criteria.length ? criteria : ['works as the Spec describes']).map(
    (c) => `- [ ] On ${platform}: ${c}`,
  );

  const key = headingKey(platform);
  const section = headings.find((h) => h.level === 2 && headingKey(h.text) === key);
  const out = [...lines];
  if (section) {
    const sub = headings.find(
      (h) =>
        h.level === 3 &&
        h.line > section.line &&
        h.line < section.end &&
        (ACCEPTANCE_HEADINGS as readonly string[]).includes(headingKey(h.text)),
    );
    if (sub) out.splice(sub.line + 1, 0, '', ...items);
    else out.splice(section.end, 0, '### Acceptance criteria', '', ...items, '');
  } else {
    const outOfScope = headings.find((h) => h.level === 2 && headingKey(h.text) === 'out of scope');
    const at = outOfScope?.line ?? out.length;
    out.splice(at, 0, `## ${platform}`, '', '### Acceptance criteria', '', ...items, '');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** A line of the Spec's "Open questions" that still asks something (not the template's "…"). */
function openQuestionsOf(specMarkdown: string): string[] {
  const { lines, headings } = specHeadings(specMarkdown);
  const section = headings.find(
    (h) =>
      h.level === 2 && ['open questions', 'คำถามที่ยังเปิดอยู่', 'คำถามค้าง'].includes(headingKey(h.text)),
  );
  if (!section) return [];
  return lines
    .slice(section.line + 1, section.end)
    .map((l) => l.match(/^\s*[-*]\s+(?:\[[ xX]?\]\s*)?(.+)$/)?.[1]?.trim() ?? '')
    .filter((t) => t && !/^[.…\s]+$/.test(t));
}

/** The checklist items of a Spec (its acceptance criteria), as the fake traces them. */
function criteriaOf(specMarkdown: string): string[] {
  return specMarkdown
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/)?.[1]?.trim() ?? '')
    .filter((t) => t && !/^[.…\s]+$/.test(t));
}

/**
 * The fake's Design Doc (ticket 0069), deterministic and only from what it is given: each
 * `##` section of the template, in order. The first section (QA: the test cases) traces each
 * checklist item of the Spec it was given and names each Decision in the context; the others
 * say they follow the Spec Version; "Open questions" lists the Spec's own open questions,
 * which also come back as `questions` (less those already asked). In Thai for a Thai Spec. An
 * update is the current Design Doc with one line naming the Spec Version and its first change.
 * It never follows anything written in the Spec or the context.
 */
export function fakeDesignDoc(input: Parameters<AiPort['draftDesignDoc']>[0]): DesignDocDraft {
  const thai = /[\u0E00-\u0E7F]/.test(input.specMarkdown);
  const v = input.specVersion;
  if (input.current !== null) {
    const change =
      input.specChange
        ?.split('\n')
        .find((l) => l.startsWith('+ ') && l.slice(2).trim())
        ?.slice(2)
        .trim() ?? '';
    const line = thai
      ? `- ปรับตาม Spec v${v}: ${change}`.trim()
      : `- Updated for Spec v${v}: ${change}`.trim();
    return {
      proposedMarkdown: `${input.current.trimEnd()}\n${line}\n`,
      summary: thai
        ? `ปรับ Design Doc ${input.doc.name} ตาม Spec v${v}`
        : `Updated the ${input.doc.name} Design Doc for Spec v${v}.`,
      questions: [],
    };
  }
  const asked = new Set(input.asked.map((a) => a.toLowerCase()));
  const open = openQuestionsOf(input.specMarkdown);
  const questions = open
    .filter((q) => !asked.has(q.slice(0, 120).toLowerCase()))
    .slice(0, 5)
    .map((q) => ({
      title: q.slice(0, 120),
      description: thai
        ? `Spec ยังไม่ได้ตัดสินเรื่องนี้ และ Design Doc ${input.doc.name} ต้องใช้`
        : `The Spec leaves this open, and the ${input.doc.name} Design Doc needs it.`,
    }));
  const criteria = criteriaOf(input.specMarkdown);
  const decisions = input.context
    .filter((b) => b.source.kind === 'DECISION')
    .map((b) => b.source.title);
  const headings = specHeadings(input.doc.template).headings.filter((h) => h.level === 2);
  const isQuestions = (text: string) =>
    ['open questions', 'คำถามที่ยังเปิดอยู่'].includes(headingKey(text));
  const qa = input.doc.platform === null;
  let traced = false;
  const sections = headings.map((h) => {
    if (isQuestions(h.text)) {
      const items = open.length ? open.map((q) => `- ${q}`) : [thai ? '- ไม่มี' : '- None.'];
      return `## ${h.text}\n\n${items.join('\n')}`;
    }
    const tracesHere = qa ? headingKey(h.text) === 'test cases' : !traced;
    if (tracesHere) {
      traced = true;
      const items = qa
        ? criteria.map(
            (c, i) => `- [ ] TC-${i + 1} (AC: ${c}): ${thai ? 'ตรวจว่า' : 'check that'} ${c}`,
          )
        : [
            ...criteria.map((c) => `- ${thai ? 'ครอบคลุม' : 'Covers'}: ${c}`),
            ...decisions.map((d) => `- ${thai ? 'ตาม Decision' : 'Follows the Decision'} "${d}"`),
          ];
      const fallback = thai ? `- ตาม Spec v${v}` : `- As Spec v${v} describes.`;
      return `## ${h.text}\n\n${(items.length ? items : [fallback]).join('\n')}`;
    }
    if (qa && headingKey(h.text) === 'test plan') {
      const names = input.doc.targets.map((t) => t.name).join(', ') || '-';
      return `## ${h.text}\n\n- ${thai ? 'ทดสอบบน' : 'Tested on'}: ${names}`;
    }
    return `## ${h.text}\n\n${thai ? `- ตาม Spec v${v}` : `- As Spec v${v} describes.`}`;
  });
  return {
    proposedMarkdown: `# ${input.doc.name} Design Doc: ${input.feature.title}\n\n${sections.join('\n\n')}\n`,
    summary: thai
      ? `ร่าง Design Doc ${input.doc.name} จาก Spec v${v}`
      : `Drafted the ${input.doc.name} Design Doc from Spec v${v}.`,
    questions,
  };
}

/** What the fake reports as one call's usage, unless a test changes `usage`. */
export const FAKE_USAGE: CallUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 800,
  cacheWriteTokens: 150,
  reasoningTokens: 100,
};

/** The thinking tokens a fake chat step reports at each Reasoning Level (ticket 0081). */
export const FAKE_REASONING_TOKENS = { NONE: 0, LOW: 16, MEDIUM: 64, HIGH: 640 } as const;

/** Deterministic stand-in for tests. Records calls so tests can assert on them. */
export class FakeAiPort implements AiPort {
  /** Every call, with the model it was asked to run on (null when none was chosen). */
  readonly calls: {
    method: keyof AiPort;
    input: unknown;
    model: ModelChoice | null;
    /** The reply language the call was asked for (ticket 0068); null when none was given. */
    language: ReplyLanguage | null;
    /** The version of the prompt it would render (ticket 0071); null when none was chosen. */
    prompt: PromptChoice | null;
    /** The Reasoning Level it was asked to run at (ticket 0081); null when none was chosen. */
    reasoning: ReasoningChoice | null;
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
      prompt: options?.prompt ?? null,
      reasoning: options?.reasoning ?? null,
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
      missingSections?: PlatformForAi[];
      agentSkills?: AgentSkillForAi[];
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
      prompt: options?.prompt ?? null,
      reasoning: options?.reasoning ?? null,
    });
    const scripted = this.chatScript.shift();
    const chunks: ChatChunk[] = scripted
      ? (scripted.chunks ?? [])
      : (fakeSkillStep(input) ??
        (fakeChatReply(input).match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text', delta })));
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
      options?.onUsage?.({
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        // The fake thinks more the higher the level, so a Think deeper reply shows it.
        reasoningTokens: FAKE_REASONING_TOKENS[options?.reasoning?.level ?? 'NONE'],
      });
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
      missingSections?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.record('draftSpecProposal', input, options);
    return {
      proposedMarkdown: `${input.specMarkdown.trimEnd()}\n${fakePlatformSections(input.missingSections)}\n## Decisions\n- ${input.request.title}: ${describeDecision(input.decision).split('\n')[0]}\n`,
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
      missingSections?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.record('draftSpecFromAttachments', input, options);
    const titles = new Set(
      input.context.filter((b) => b.source.kind === 'ATTACHMENT').map((b) => b.source.title),
    );
    const sources = [...titles].map((title) => `- ${title}`).join('\n');
    return {
      proposedMarkdown: `# ${input.feature.title}\n\n## Sources\n${sources}\n${fakePlatformSections(input.missingSections)}`,
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
      uncoveredPlatforms?: PlatformForAi[];
    },
    options?: AiCallOptions,
  ) {
    this.record('grillingQuestions', input, options);
    const known = input.projectContext.map((b) => b.text.toLowerCase()).join('\n');
    const questions = FAKE_GRILLING_TOPICS[input.round]
      .filter((t) => !known.includes(t.keyword))
      .map((t) => t.question);
    // Platforms no Feature covers (ticket 0051): asked once, in the round about platforms.
    const uncovered = input.uncoveredPlatforms ?? [];
    if (input.round === 'UX' && uncovered.length) questions.push(fakeUncoveredQuestion(uncovered));
    return { questions };
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

  async draftAcceptanceCriteria(
    input: Parameters<AiPort['draftAcceptanceCriteria']>[0],
    options?: AiCallOptions,
  ) {
    this.record('draftAcceptanceCriteria', input, options);
    return {
      proposedMarkdown: fakeAcceptanceCriteria(
        input.specMarkdown,
        input.platform.name,
        input.context,
      ),
      summary: `Added acceptance criteria for ${input.platform.name}.`,
    };
  }

  /**
   * The patterns of FAKE_FEEDBACK_PATTERNS that at least two cases show, and "Often edited by
   * hand" when two or more were MANUAL_EDITs; each cites its cases.
   */
  async analyzeFeedback(
    input: Parameters<AiPort['analyzeFeedback']>[0],
    options?: AiCallOptions,
  ): Promise<FeedbackAnalysis> {
    this.record('analyzeFeedback', input, options);
    const patterns: FeedbackAnalysis['patterns'] = [];
    for (const p of FAKE_FEEDBACK_PATTERNS) {
      const cases = input.cases.filter((c) => c.text && p.match.test(c.text)).map((c) => c.index);
      if (cases.length >= 2) patterns.push({ title: p.title, description: p.description, cases });
    }
    const edits = input.cases.filter((c) => c.outcome === 'MANUAL_EDIT').map((c) => c.index);
    if (edits.length >= 2) {
      patterns.push({
        title: 'Often edited by hand after approval',
        description: 'People approve, then fix the result themselves.',
        cases: edits,
      });
    }
    return { patterns: patterns.sort((a, b) => b.cases.length - a.cases.length) };
  }

  /** The template with one line per pattern added at its end (`fakeGuidance`). */
  async proposePromptVersion(
    input: Parameters<AiPort['proposePromptVersion']>[0],
    options?: AiCallOptions,
  ): Promise<ProposedPromptVersion> {
    this.record('proposePromptVersion', input, options);
    return {
      template: `${input.template.trimEnd()}\n\n${input.patterns.map((p) => fakeGuidance(p.title)).join('\n')}\n`,
      rationale: `Addresses ${input.patterns.map((p) => `"${p.title}" (${p.count} cases)`).join(', ')}.`,
    };
  }

  /** The current Redraft's template with "- Changed as asked: <feedback>" added. */
  async redraftPromptVersion(
    input: Parameters<AiPort['redraftPromptVersion']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedPromptVersion> {
    this.record('redraftPromptVersion', input, options);
    await this.nextRedraft();
    const n = input.current + 1;
    const first = input.feedback.feedback.split('\n')[0]?.trim().slice(0, 200) ?? '';
    return {
      template: `${input.template.trimEnd()}\n${fakeRedraftLine(input.feedback.feedback)}\n`,
      rationale: `${input.rationale} Changed as asked: ${first}`,
      summary: `Redraft ${n}: ${first.slice(0, 80)}`,
      preferences: fakePreferences(input.feedback.feedback),
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

  /** A Design Doc from the template and the Spec it is given (`fakeDesignDoc`). */
  async draftDesignDoc(
    input: Parameters<AiPort['draftDesignDoc']>[0],
    options?: AiCallOptions,
  ): Promise<DesignDocDraft> {
    this.record('draftDesignDoc', input, options);
    await this.nextDesignDoc();
    return fakeDesignDoc(input);
  }

  /**
   * Waited on (a Promise) or thrown (an Error) by the next Design Doc drafts, in order, to
   * hold a draft open or make it fail (ticket 0069).
   */
  readonly designDocScript: (Error | Promise<unknown>)[] = [];

  private async nextDesignDoc(): Promise<void> {
    const next = this.designDocScript.shift();
    if (next instanceof Error) throw next;
    if (next) await next;
  }

  /** The current Redraft with one line added: "- Changed as asked: <feedback>". */
  async redraftDesignDoc(
    input: Parameters<AiPort['redraftDesignDoc']>[0],
    options?: AiCallOptions,
  ): Promise<RedraftedMarkdown> {
    this.record('redraftDesignDoc', input, options);
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
