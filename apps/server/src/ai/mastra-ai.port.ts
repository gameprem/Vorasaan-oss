import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@mastra/core/agent';
import { ConsoleLogger } from '@mastra/core/logger';
import { createTool } from '@mastra/core/tools';
import { Logger } from '@nestjs/common';
import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import { z } from 'zod';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import type { AiTask } from './ai.config.ts';
import {
  type ActionCardForAi,
  type AgentSkillForAi,
  type AiCallOptions,
  type AiPort,
  type AttachmentForAi,
  AttachmentSummary,
  BriefDraft,
  type ChatChunk,
  type ChatMessageForAi,
  type ChatTool,
  type ContextBlock,
  ContextTooLongError,
  ConversationFoldDraft,
  type ConversationScopeForAi,
  type DecisionForAi,
  DesignDocDraft,
  type DismissedSuggestionForAi,
  FeatureFitDraft,
  type FeatureForAi,
  FeatureSuggestionDrafts,
  FeedbackAnalysis,
  GeneratedChoices,
  type GrillingAnswerForAi,
  GrillingFollowUpDecision,
  type GrillingFollowUpForAi,
  GrillingQuestionDrafts,
  type GuidelineForAi,
  isContextTooLong,
  type ModelChoice,
  type PlatformForAi,
  type ProjectForAi,
  type ProjectFoundationForAi,
  ProposedPromptVersion,
  type RecordForAi,
  RedraftedChoices,
  RedraftedMarkdown,
  RedraftedPromptVersion,
  RedraftedSuggestion,
  type RequestForAi,
  SpecProposalDraft,
  type SuggestionForAi,
} from './ai.port.ts';
import type { LanguageStrategy } from './language.ts';
import { type MastraModel, mastraModelOf } from './model-config.ts';
import {
  type CacheUsage,
  cacheMarkOf,
  logCacheUsage,
  markedSystem,
  markedUserMessage,
  type Prompt,
  wholePrompt,
} from './prompt-cache.ts';
import { chatPrompt, type PromptOptions, TASK_PROMPTS } from './prompts.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';
import { estimateChatTokens, messagesAsText } from './token-count.ts';
import type { WorkflowMemory } from './workflow-memory.ts';

const INSTRUCTIONS =
  'You are Vorasaan, an assistant that helps software teams align on what to build. ' +
  'Follow the task instructions exactly and return only the requested structure.';

const INSTRUCTIONS_TOKENS = estimateTokens(INSTRUCTIONS);

export type { AiTask };

/** Logs a call's usage and cache hits (ticket 0061); a missing usage never fails the call. */
async function logUsage(
  task: string,
  usage: PromiseLike<unknown> | unknown,
): Promise<CacheUsage | null> {
  try {
    return logCacheUsage(task, await usage);
  } catch {
    // Usage is for the log (and the context meter) only.
    return null;
  }
}

/**
 * The Mastra model for one call. `chosen` is the model the server picked for the
 * call (`ModelRoutingAiPort`); the default uses it. Eval scripts pass their own.
 */
export type ModelResolver = (task: AiTask, chosen: ModelChoice | undefined) => Promise<MastraModel>;

const useChosenModel: ModelResolver = async (task, chosen) => {
  if (!chosen) throw new Error(`No model was chosen for the AI task "${task}"`);
  return mastraModelOf(chosen);
};

type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];

/** The key a Mastra model carries, if any. */
function keyOf(model: MastraModel): string | null {
  return typeof model === 'string' ? null : model.apiKey || null;
}

/** A value as logged, with every occurrence of the secret masked. Errors keep their fields. */
function redact(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.replaceAll(secret, '…');
  try {
    const json = JSON.stringify(value, (_key, v) =>
      v instanceof Error ? { ...v, name: v.name, message: v.message } : v,
    );
    return json === undefined ? value : JSON.parse(json.replaceAll(secret, '…'));
  } catch {
    // Not JSON (a cycle, a BigInt): its text, masked.
    return String(value).replaceAll(secret, '…');
  }
}

/**
 * Mastra's console logger with the call's key masked (ticket 0064): Mastra logs a
 * provider's error with its response body, and a provider may echo the key there.
 */
class RedactingLogger extends ConsoleLogger {
  constructor(
    name: string,
    private readonly secret: string,
  ) {
    super({ name });
  }

  /** Mastra logs through children of the Agent's logger: they mask too. */
  override child(): ConsoleLogger {
    return this;
  }

  override debug(message: string, ...args: unknown[]) {
    super.debug(this.mask(message), ...this.maskAll(args));
  }

  override info(message: string, ...args: unknown[]) {
    super.info(this.mask(message), ...this.maskAll(args));
  }

  override warn(message: string, ...args: unknown[]) {
    super.warn(this.mask(message), ...this.maskAll(args));
  }

  override error(message: string, ...args: unknown[]) {
    super.error(this.mask(message), ...this.maskAll(args));
  }

  private mask(message: string): string {
    return String(redact(message, this.secret));
  }

  private maskAll(args: unknown[]): unknown[] {
    return args.map((a) => redact(a, this.secret));
  }
}

/** The Agent, its own log lines never carrying the model's key. */
function redactLogs<A extends { name: string; __setLogger(logger: ConsoleLogger): void }>(
  agent: A,
  model: MastraModel,
): A {
  const key = keyOf(model);
  // A very short key would mask ordinary words; providers' keys are far longer.
  if (key && key.length >= 8) agent.__setLogger(new RedactingLogger(`AGENT - ${agent.name}`, key));
  return agent;
}

/** `onUsage` is told each call's usage (ticket 0070), for its Receipt. */
export function agentGenerate(
  task: string,
  model: MastraModel,
  onUsage?: (usage: CacheUsage) => void,
): StructuredGenerate {
  const agent = redactLogs(
    new Agent({ id: task, name: task, instructions: INSTRUCTIONS, model: model as AgentModel }),
    model,
  );
  const mark = cacheMarkOf(model);
  // Always stream: some OpenAI-compatible routers (e.g. 9Router) answer with SSE even
  // for non-streaming requests, which breaks a plain generate() call. Streaming works
  // with every provider, and we only need the final validated object.
  return async (input, schema) => {
    const prompt = typeof input === 'string' ? wholePrompt(input) : input;
    // Anthropic, directly or through OpenRouter: the prompt's stable parts carry
    // cache_control (tickets 0061, 0064). Every other model gets the whole text, as before.
    const message = mark ? [markedUserMessage(prompt, mark, INSTRUCTIONS_TOKENS)] : prompt.text;
    const stream = await agent.stream(message as Parameters<typeof agent.stream>[0], {
      structuredOutput: { schema },
    });
    const object = await stream.object;
    const usage = await logUsage(task, stream.usage);
    if (usage) onUsage?.(usage);
    return object;
  };
}

// Mastra used as a library (ADR 0003): no Mastra server, no storage needed yet.
export class MastraAiPort implements AiPort {
  constructor(
    private readonly resolveModel: ModelResolver = useChosenModel,
    /**
     * How prompts reach the reply language (ticket 0068). The product answers
     * directly; the eval scripts pass `english-first` to compare (`--english-first`).
     */
    private readonly languageStrategy: LanguageStrategy = 'direct',
  ) {}

  /**
   * How a prompt of this call is rendered: its language rules, and the Prompt Version
   * chosen for it (ticket 0071; none, the built-in default).
   */
  private lang(options: AiCallOptions | undefined): PromptOptions {
    return {
      language: options?.language,
      strategy: this.languageStrategy,
      template: options?.prompt?.template ?? null,
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
    const prompt = await TASK_PROMPTS.generateChoices(input, this.lang(options));
    const generate = agentGenerate(
      'generate-choices',
      await this.resolveModel('generateChoices', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'generate-choices', prompt, GeneratedChoices);
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
    const prompt = await TASK_PROMPTS.draftSpecProposal(input, this.lang(options));
    const generate = agentGenerate(
      'draft-spec-proposal',
      await this.resolveModel('draftSpecProposal', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-spec-proposal', prompt, SpecProposalDraft);
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }, options?: AiCallOptions) {
    const prompt = await TASK_PROMPTS.summarizeAttachment(input, this.lang(options));
    const generate = agentGenerate(
      'summarize-attachment',
      await this.resolveModel('summarizeAttachment', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'summarize-attachment', prompt, AttachmentSummary);
  }

  async draftSpecFromAttachments(
    input: {
      feature: FeatureForAi;
      specMarkdown: string;
      context: ContextBlock[];
    },
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.draftSpecFromAttachments(input, this.lang(options));
    const generate = agentGenerate(
      'draft-spec-from-attachments',
      await this.resolveModel('draftSpecFromAttachments', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-spec-from-attachments', prompt, SpecProposalDraft);
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
    const prompt = await TASK_PROMPTS.grillingQuestions(input, this.lang(options));
    const generate = agentGenerate(
      'grilling-questions',
      await this.resolveModel('grillingQuestions', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'grilling-questions', prompt, GrillingQuestionDrafts);
  }

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
  ) {
    const prompt = await TASK_PROMPTS.grillingFollowUp(input, this.lang(options));
    const generate = agentGenerate(
      'grilling-follow-up',
      await this.resolveModel('grillingFollowUp', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'grilling-follow-up', prompt, GrillingFollowUpDecision);
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
    const prompt = await TASK_PROMPTS.draftBriefFromGrilling(input, this.lang(options));
    const generate = agentGenerate(
      'draft-brief-from-grilling',
      await this.resolveModel('draftBriefFromGrilling', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-brief-from-grilling', prompt, BriefDraft);
  }

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
  ) {
    const prompt = await TASK_PROMPTS.suggestFeatures(input, this.lang(options));
    const generate = agentGenerate(
      'suggest-features',
      await this.resolveModel('suggestFeatures', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'suggest-features', prompt, FeatureSuggestionDrafts);
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
    const prompt = await TASK_PROMPTS.draftSpecFromSuggestion(input, this.lang(options));
    const generate = agentGenerate(
      'draft-spec-from-suggestion',
      await this.resolveModel('draftSpecFromSuggestion', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-spec-from-suggestion', prompt, SpecProposalDraft);
  }

  async checkFeatureFit(
    input: {
      project: ProjectForAi;
      feature: FeatureForAi;
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    },
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.checkFeatureFit(input, this.lang(options));
    const generate = agentGenerate(
      'check-feature-fit',
      await this.resolveModel('checkFeatureFit', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'check-feature-fit', prompt, FeatureFitDraft);
  }

  async draftAcceptanceCriteria(
    input: Parameters<AiPort['draftAcceptanceCriteria']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.draftAcceptanceCriteria(input, this.lang(options));
    const generate = agentGenerate(
      'draft-acceptance-criteria',
      await this.resolveModel('draftAcceptanceCriteria', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-acceptance-criteria', prompt, SpecProposalDraft);
  }

  async redraftChoices(input: Parameters<AiPort['redraftChoices']>[0], options?: AiCallOptions) {
    const prompt = await TASK_PROMPTS.redraftChoices(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-choices',
      await this.resolveModel('redraftChoices', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-choices', prompt, RedraftedChoices);
  }

  async redraftSpecProposal(
    input: Parameters<AiPort['redraftSpecProposal']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.redraftSpecProposal(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-spec-proposal',
      await this.resolveModel('redraftSpecProposal', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-spec-proposal', prompt, RedraftedMarkdown);
  }

  async redraftBriefProposal(
    input: Parameters<AiPort['redraftBriefProposal']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.redraftBriefProposal(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-brief-proposal',
      await this.resolveModel('redraftBriefProposal', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-brief-proposal', prompt, RedraftedMarkdown);
  }

  async redraftFeatureSuggestion(
    input: Parameters<AiPort['redraftFeatureSuggestion']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.redraftFeatureSuggestion(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-feature-suggestion',
      await this.resolveModel('redraftFeatureSuggestion', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-feature-suggestion', prompt, RedraftedSuggestion);
  }

  async analyzeFeedback(input: Parameters<AiPort['analyzeFeedback']>[0], options?: AiCallOptions) {
    const prompt = await TASK_PROMPTS.analyzeFeedback(input, this.lang(options));
    const generate = agentGenerate(
      'analyze-feedback',
      await this.resolveModel('analyzeFeedback', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'analyze-feedback', prompt, FeedbackAnalysis);
  }

  async proposePromptVersion(
    input: Parameters<AiPort['proposePromptVersion']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.proposePromptVersion(input, this.lang(options));
    const generate = agentGenerate(
      'propose-prompt-version',
      await this.resolveModel('proposePromptVersion', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'propose-prompt-version', prompt, ProposedPromptVersion);
  }

  async redraftPromptVersion(
    input: Parameters<AiPort['redraftPromptVersion']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.redraftPromptVersion(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-prompt-version',
      await this.resolveModel('redraftPromptVersion', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-prompt-version', prompt, RedraftedPromptVersion);
  }

  async draftDesignDoc(input: Parameters<AiPort['draftDesignDoc']>[0], options?: AiCallOptions) {
    const prompt = await TASK_PROMPTS.draftDesignDoc(input, this.lang(options));
    const generate = agentGenerate(
      'draft-design-doc',
      await this.resolveModel('draftDesignDoc', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'draft-design-doc', prompt, DesignDocDraft);
  }

  async redraftDesignDoc(
    input: Parameters<AiPort['redraftDesignDoc']>[0],
    options?: AiCallOptions,
  ) {
    const prompt = await TASK_PROMPTS.redraftDesignDoc(input, this.lang(options));
    const generate = agentGenerate(
      'redraft-design-doc',
      await this.resolveModel('redraftDesignDoc', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'redraft-design-doc', prompt, RedraftedMarkdown);
  }

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
    const instructions = await chatPrompt(input, this.lang(options));
    const model = await this.resolveModel('chat', options?.model);
    try {
      yield* streamChat(
        model,
        instructions,
        input.recentMessages,
        input.tools,
        input.signal,
        options?.onUsage,
      );
    } catch (error) {
      // A request longer than the model's window: the Conversation compacts and retries once.
      if (isContextTooLong(error)) throw new ContextTooLongError(error);
      throw error;
    }
  }

  /**
   * Anthropic's counting API (`messages.countTokens`) for an Anthropic model;
   * the script-aware estimate for every other provider (OpenRouter has no counting
   * call, even for an Anthropic model routed through it), and whenever counting
   * fails (it must never fail a turn). The messages are counted as one text.
   */
  async countTokens(
    input: { system: string; messages: ChatMessageForAi[] },
    options?: AiCallOptions,
  ): Promise<number> {
    const target = anthropicTarget(options?.model);
    if (!target) return estimateChatTokens(input);
    try {
      const client = new Anthropic({
        apiKey: target.apiKey,
        ...(target.baseUrl ? { baseURL: target.baseUrl } : {}),
        maxRetries: 1,
        timeout: 10_000,
      });
      const counted = await client.messages.countTokens({
        model: target.model,
        ...(input.system.trim() ? { system: input.system } : {}),
        messages: [{ role: 'user', content: messagesAsText(input.messages) || '(No messages.)' }],
      });
      return counted.input_tokens;
    } catch (error) {
      new Logger('MastraAiPort').warn(
        `Counting tokens failed, using the estimate: ${(error as Error)?.message ?? error}`,
      );
      return estimateChatTokens(input);
    }
  }

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
  ) {
    const prompt = await TASK_PROMPTS.summarizeConversation(input, this.lang(options));
    const generate = agentGenerate(
      'summarize-conversation',
      await this.resolveModel('summarizeConversation', options?.model),
      options?.onUsage,
    );
    return generateStructured(generate, 'summarize-conversation', prompt, ConversationFoldDraft);
  }
}

type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content:
        | string
        | (
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          )[];
    }
  | {
      role: 'tool';
      content: {
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: { type: 'text'; value: string };
      }[];
    };

/**
 * The recent messages as the chat itself, in the AI SDK's model message format.
 * With tools offered, earlier tool calls and their results are passed as such;
 * a call whose result isn't among the messages is left out, and a result whose
 * call isn't (it was folded into the summary) becomes plain text. Without tools
 * (the last step of a turn), every call and result is plain text, since some
 * providers refuse tool messages when no tools are defined.
 */
export function toAgentMessages(messages: ChatMessageForAi[], withTools: boolean): AgentMessage[] {
  const answered = new Set(messages.flatMap((m) => (m.role === 'TOOL' ? [m.toolCallId] : [])));
  const called = new Map<string, string>();
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'USER') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'ASSISTANT') {
      const calls = (m.toolCalls ?? []).filter((c) => answered.has(c.id));
      if (!withTools || !calls.length) {
        const described = calls.map(
          (c) => `(Called the tool ${c.name} with ${JSON.stringify(c.args)})`,
        );
        const content = [m.content, ...described].filter((t) => t.trim()).join('\n\n');
        out.push({ role: 'assistant', content: content || '(No text.)' });
        continue;
      }
      for (const c of calls) called.set(c.id, c.name);
      out.push({
        role: 'assistant',
        content: [
          ...(m.content.trim() ? [{ type: 'text' as const, text: m.content }] : []),
          ...calls.map((c) => ({
            type: 'tool-call' as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.args ?? {},
          })),
        ],
      });
    } else {
      const toolName = called.get(m.toolCallId);
      if (!withTools || !toolName) {
        out.push({ role: 'user', content: `(Result of an earlier tool call)\n${m.content}` });
        continue;
      }
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId,
            toolName,
            output: { type: 'text', value: m.content },
          },
        ],
      });
    }
  }
  return out;
}

/**
 * The offered tools, without an `execute`: the model may call them, but only
 * the server runs them (ADR 0008), so the step ends at the first tool call.
 */
function toAgentTools(tools: ChatTool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      createTool({ id: t.name, description: t.description, inputSchema: t.inputSchema }),
    ]),
  );
}

/**
 * One step of a Conversation reply: text streamed as written, and the tools the
 * model calls. Mastra runs none of them; they are client tools the server runs.
 */
async function* streamChat(
  model: MastraModel,
  instructions: Prompt,
  messages: ChatMessageForAi[],
  tools: ChatTool[],
  signal: AbortSignal | undefined,
  onUsage?: (usage: CacheUsage) => void,
): AsyncIterable<ChatChunk> {
  // Anthropic, directly or through OpenRouter: the system prompt's stable parts carry
  // cache_control (tickets 0061, 0064). Every other model gets the whole text as one
  // system prompt, as before.
  const mark = cacheMarkOf(model);
  const agent = redactLogs(
    new Agent({
      id: 'chat',
      name: 'chat',
      instructions: mark ? markedSystem(instructions, mark) : instructions.text,
      model: model as AgentModel,
    }),
    model,
  );
  const output = await agent.stream(toAgentMessages(messages, tools.length > 0), {
    maxSteps: 1,
    ...(tools.length ? { clientTools: toAgentTools(tools) } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  });
  for await (const chunk of output.fullStream) {
    // Stopped (ticket 0046): end here, whatever the provider still sends.
    if (signal?.aborted) return;
    if (chunk.type === 'text-delta') {
      if (chunk.payload.text) yield { type: 'text', delta: chunk.payload.text };
    } else if (chunk.type === 'tool-call') {
      yield {
        type: 'tool-call',
        call: {
          id: chunk.payload.toolCallId,
          name: chunk.payload.toolName,
          args: chunk.payload.args ?? {},
        },
      };
    } else if (chunk.type === 'error') {
      throw chunk.payload.error instanceof Error
        ? chunk.payload.error
        : new Error(`The chat stream failed: ${String(chunk.payload.error)}`);
    }
  }
  const usage = await logUsage('chat', output.usage);
  if (usage) onUsage?.(usage);
  // The context meter shows the last turn's cache reads (ticket 0066).
  if (usage && (usage.inputTokens !== null || usage.cacheReadTokens !== null)) {
    yield {
      type: 'usage',
      usage: { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens },
    };
  }
}

/** The Anthropic model and key to count with, when the call runs on Anthropic. */
function anthropicTarget(
  choice: ModelChoice | undefined,
): { model: string; apiKey: string; baseUrl: string | null } | null {
  if (!choice) return null;
  if (choice.provider) {
    if (choice.provider.provider !== 'ANTHROPIC') return null;
    return {
      model: choice.provider.model,
      apiKey: choice.provider.apiKey,
      baseUrl: choice.provider.baseUrl,
    };
  }
  // An env model ("anthropic/…") with the env key.
  const [prefix, ...rest] = choice.name.split('/');
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (prefix !== 'anthropic' || !rest.length || !apiKey) return null;
  return { model: rest.join('/'), apiKey, baseUrl: null };
}

const PingResult = z.object({ reply: z.string() });

/** A tiny structured call to check that a provider config works. */
export async function pingModel(model: MastraModel): Promise<void> {
  const generate = agentGenerate('connection-test', model);
  const raw = await generate('Reply with the single word "ok" in the `reply` field.', PingResult);
  PingResult.parse(raw);
}
