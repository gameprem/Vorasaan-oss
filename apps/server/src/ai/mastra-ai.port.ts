import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Logger } from '@nestjs/common';
import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import { z } from 'zod';
import type { AiTask } from './ai.config.ts';
import {
  type ActionCardForAi,
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
  type ConversationScopeForAi,
  ConversationSummaryDraft,
  type DecisionForAi,
  type DismissedSuggestionForAi,
  FeatureFitDraft,
  type FeatureForAi,
  FeatureSuggestionDrafts,
  GeneratedChoices,
  type GrillingAnswerForAi,
  GrillingFollowUpDecision,
  type GrillingFollowUpForAi,
  GrillingQuestionDrafts,
  type GuidelineForAi,
  isContextTooLong,
  type ModelChoice,
  type ProjectForAi,
  type ProjectFoundationForAi,
  type RequestForAi,
  SpecProposalDraft,
  type SuggestionForAi,
} from './ai.port.ts';
import { type MastraModel, mastraModelOf } from './model-config.ts';
import {
  chatPrompt,
  checkFeatureFitPrompt,
  draftBriefFromGrillingPrompt,
  draftSpecFromAttachmentsPrompt,
  draftSpecFromSuggestionPrompt,
  draftSpecProposalPrompt,
  generateChoicesPrompt,
  grillingFollowUpPrompt,
  grillingQuestionsPrompt,
  suggestFeaturesPrompt,
  summarizeAttachmentPrompt,
  summarizeConversationPrompt,
} from './prompts.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';
import { estimateChatTokens, messagesAsText } from './token-count.ts';
import type { WorkflowMemory } from './workflow-memory.ts';

const INSTRUCTIONS =
  'You are Vorasaan, an assistant that helps software teams align on what to build. ' +
  'Follow the task instructions exactly and return only the requested structure.';

export type { AiTask };

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

export function agentGenerate(task: string, model: MastraModel): StructuredGenerate {
  const agent = new Agent({
    id: task,
    name: task,
    instructions: INSTRUCTIONS,
    model: model as AgentModel,
  });
  // Always stream: some OpenAI-compatible routers (e.g. 9Router) answer with SSE even
  // for non-streaming requests, which breaks a plain generate() call. Streaming works
  // with every provider, and we only need the final validated object.
  return async (prompt, schema) => {
    const stream = await agent.stream(prompt, { structuredOutput: { schema } });
    return stream.object;
  };
}

// Mastra used as a library (ADR 0003): no Mastra server, no storage needed yet.
export class MastraAiPort implements AiPort {
  constructor(private readonly resolveModel: ModelResolver = useChosenModel) {}

  async generateChoices(
    input: {
      specMarkdown: string;
      request: RequestForAi;
      context: ContextBlock[];
      foundation?: ProjectFoundationForAi;
    },
    options?: AiCallOptions,
  ) {
    const prompt = await generateChoicesPrompt(
      input.specMarkdown,
      input.request,
      input.context,
      input.foundation,
    );
    const generate = agentGenerate(
      'generate-choices',
      await this.resolveModel('generateChoices', options?.model),
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
    const prompt = await draftSpecProposalPrompt(
      input.specMarkdown,
      input.request,
      input.decision,
      input.context,
      input.foundation,
    );
    const generate = agentGenerate(
      'draft-spec-proposal',
      await this.resolveModel('draftSpecProposal', options?.model),
    );
    return generateStructured(generate, 'draft-spec-proposal', prompt, SpecProposalDraft);
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }, options?: AiCallOptions) {
    const prompt = await summarizeAttachmentPrompt(input.attachment);
    const generate = agentGenerate(
      'summarize-attachment',
      await this.resolveModel('summarizeAttachment', options?.model),
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
    const prompt = await draftSpecFromAttachmentsPrompt(
      input.feature,
      input.specMarkdown,
      input.context,
    );
    const generate = agentGenerate(
      'draft-spec-from-attachments',
      await this.resolveModel('draftSpecFromAttachments', options?.model),
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
    const prompt = await grillingQuestionsPrompt(input);
    const generate = agentGenerate(
      'grilling-questions',
      await this.resolveModel('grillingQuestions', options?.model),
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
    const prompt = await grillingFollowUpPrompt(input);
    const generate = agentGenerate(
      'grilling-follow-up',
      await this.resolveModel('grillingFollowUp', options?.model),
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
    const prompt = await draftBriefFromGrillingPrompt(input);
    const generate = agentGenerate(
      'draft-brief-from-grilling',
      await this.resolveModel('draftBriefFromGrilling', options?.model),
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
    const prompt = await suggestFeaturesPrompt(input);
    const generate = agentGenerate(
      'suggest-features',
      await this.resolveModel('suggestFeatures', options?.model),
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
    const prompt = await draftSpecFromSuggestionPrompt(input);
    const generate = agentGenerate(
      'draft-spec-from-suggestion',
      await this.resolveModel('draftSpecFromSuggestion', options?.model),
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
    const prompt = await checkFeatureFitPrompt(input);
    const generate = agentGenerate(
      'check-feature-fit',
      await this.resolveModel('checkFeatureFit', options?.model),
    );
    return generateStructured(generate, 'check-feature-fit', prompt, FeatureFitDraft);
  }

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
    const instructions = await chatPrompt(input);
    const model = await this.resolveModel('chat', options?.model);
    try {
      yield* streamChat(model, instructions, input.recentMessages, input.tools, input.signal);
    } catch (error) {
      // A request longer than the model's window: the Conversation compacts and retries once.
      if (isContextTooLong(error)) throw new ContextTooLongError(error);
      throw error;
    }
  }

  /**
   * Anthropic's counting API (`messages.countTokens`) for an Anthropic model;
   * the script-aware estimate for every other provider, and whenever counting
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
    },
    options?: AiCallOptions,
  ) {
    const prompt = await summarizeConversationPrompt(input);
    const generate = agentGenerate(
      'summarize-conversation',
      await this.resolveModel('summarizeConversation', options?.model),
    );
    return generateStructured(generate, 'summarize-conversation', prompt, ConversationSummaryDraft);
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
  instructions: string,
  messages: ChatMessageForAi[],
  tools: ChatTool[],
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  const agent = new Agent({ id: 'chat', name: 'chat', instructions, model: model as AgentModel });
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
