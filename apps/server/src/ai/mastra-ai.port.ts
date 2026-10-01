import { Agent } from '@mastra/core/agent';
import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import { z } from 'zod';
import {
  type AiPort,
  type AttachmentForAi,
  AttachmentSummary,
  BriefDraft,
  type ChatChunk,
  type ChatMessageForAi,
  type ChatTool,
  type ContextBlock,
  type ConversationScopeForAi,
  ConversationSummaryDraft,
  type DecisionForAi,
  type DismissedSuggestionForAi,
  FeatureFitDraft,
  type FeatureForAi,
  FeatureSuggestionDrafts,
  GeneratedChoices,
  type GrillingAnswerForAi,
  GrillingQuestionDrafts,
  type GuidelineForAi,
  type ProjectForAi,
  type ProjectFoundationForAi,
  type RequestForAi,
  SpecProposalDraft,
  type SuggestionForAi,
} from './ai.port.ts';
import type { MastraModel } from './model-config.ts';
import {
  chatPrompt,
  checkFeatureFitPrompt,
  draftBriefFromGrillingPrompt,
  draftSpecFromAttachmentsPrompt,
  draftSpecFromSuggestionPrompt,
  draftSpecProposalPrompt,
  generateChoicesPrompt,
  grillingQuestionsPrompt,
  suggestFeaturesPrompt,
  summarizeAttachmentPrompt,
  summarizeConversationPrompt,
} from './prompts.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';
import type { WorkflowMemory } from './workflow-memory.ts';

const INSTRUCTIONS =
  'You are Vorasaan, an assistant that helps software teams align on what to build. ' +
  'Follow the task instructions exactly and return only the requested structure.';

export type AiTask =
  | 'generateChoices'
  | 'draftSpecProposal'
  | 'summarizeAttachment'
  | 'draftSpecFromAttachments'
  | 'grillingQuestions'
  | 'draftBriefFromGrilling'
  | 'suggestFeatures'
  | 'draftSpecFromSuggestion'
  | 'checkFeatureFit'
  | 'chat'
  | 'summarizeConversation';

/** Called on every request, so a provider saved in Settings applies immediately. */
export type ModelResolver = (task: AiTask) => Promise<MastraModel>;

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
  constructor(private readonly resolveModel: ModelResolver) {}

  async generateChoices(input: {
    specMarkdown: string;
    request: RequestForAi;
    context: ContextBlock[];
    foundation?: ProjectFoundationForAi;
  }) {
    const prompt = await generateChoicesPrompt(
      input.specMarkdown,
      input.request,
      input.context,
      input.foundation,
    );
    const generate = agentGenerate('generate-choices', await this.resolveModel('generateChoices'));
    return generateStructured(generate, 'generate-choices', prompt, GeneratedChoices);
  }

  async draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
    context: ContextBlock[];
    foundation?: ProjectFoundationForAi;
  }) {
    const prompt = await draftSpecProposalPrompt(
      input.specMarkdown,
      input.request,
      input.decision,
      input.context,
      input.foundation,
    );
    const generate = agentGenerate(
      'draft-spec-proposal',
      await this.resolveModel('draftSpecProposal'),
    );
    return generateStructured(generate, 'draft-spec-proposal', prompt, SpecProposalDraft);
  }

  async summarizeAttachment(input: { attachment: AttachmentForAi }) {
    const prompt = await summarizeAttachmentPrompt(input.attachment);
    const generate = agentGenerate(
      'summarize-attachment',
      await this.resolveModel('summarizeAttachment'),
    );
    return generateStructured(generate, 'summarize-attachment', prompt, AttachmentSummary);
  }

  async draftSpecFromAttachments(input: {
    feature: FeatureForAi;
    specMarkdown: string;
    context: ContextBlock[];
  }) {
    const prompt = await draftSpecFromAttachmentsPrompt(
      input.feature,
      input.specMarkdown,
      input.context,
    );
    const generate = agentGenerate(
      'draft-spec-from-attachments',
      await this.resolveModel('draftSpecFromAttachments'),
    );
    return generateStructured(generate, 'draft-spec-from-attachments', prompt, SpecProposalDraft);
  }

  async grillingQuestions(input: {
    project: ProjectForAi;
    round: GrillingRoundKind;
    role: TeamRole;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    memory: WorkflowMemory;
  }) {
    const prompt = await grillingQuestionsPrompt(input);
    const generate = agentGenerate(
      'grilling-questions',
      await this.resolveModel('grillingQuestions'),
    );
    return generateStructured(generate, 'grilling-questions', prompt, GrillingQuestionDrafts);
  }

  async draftBriefFromGrilling(input: {
    project: ProjectForAi;
    briefMarkdown: string;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    memory: WorkflowMemory;
    answers: GrillingAnswerForAi[];
  }) {
    const prompt = await draftBriefFromGrillingPrompt(input);
    const generate = agentGenerate(
      'draft-brief-from-grilling',
      await this.resolveModel('draftBriefFromGrilling'),
    );
    return generateStructured(generate, 'draft-brief-from-grilling', prompt, BriefDraft);
  }

  async suggestFeatures(input: {
    project: ProjectForAi;
    count: number;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
    decisions: ContextBlock[];
    dismissed: DismissedSuggestionForAi[];
    pending: string[];
  }) {
    const prompt = await suggestFeaturesPrompt(input);
    const generate = agentGenerate('suggest-features', await this.resolveModel('suggestFeatures'));
    return generateStructured(generate, 'suggest-features', prompt, FeatureSuggestionDrafts);
  }

  async draftSpecFromSuggestion(input: {
    project: ProjectForAi;
    suggestion: SuggestionForAi;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
  }) {
    const prompt = await draftSpecFromSuggestionPrompt(input);
    const generate = agentGenerate(
      'draft-spec-from-suggestion',
      await this.resolveModel('draftSpecFromSuggestion'),
    );
    return generateStructured(generate, 'draft-spec-from-suggestion', prompt, SpecProposalDraft);
  }

  async checkFeatureFit(input: {
    project: ProjectForAi;
    feature: FeatureForAi;
    projectContext: ContextBlock[];
    guidelines: GuidelineForAi[];
  }) {
    const prompt = await checkFeatureFitPrompt(input);
    const generate = agentGenerate('check-feature-fit', await this.resolveModel('checkFeatureFit'));
    return generateStructured(generate, 'check-feature-fit', prompt, FeatureFitDraft);
  }

  async *chat(input: {
    scope: ConversationScopeForAi;
    context: ContextBlock[];
    foundation: ProjectFoundationForAi;
    summary: string;
    recentMessages: ChatMessageForAi[];
    tools: ChatTool[];
    signal?: AbortSignal;
  }): AsyncIterable<ChatChunk> {
    if (input.tools.length) {
      // Tools arrive with Action Cards (0043); never silently drop one before then.
      throw new Error('Chat tools are not supported yet');
    }
    const instructions = await chatPrompt(input);
    const model = await this.resolveModel('chat');
    yield* streamChat(model, instructions, input.recentMessages, input.signal);
  }

  async summarizeConversation(input: {
    scope: ConversationScopeForAi;
    summary: string;
    messages: ChatMessageForAi[];
  }) {
    const prompt = await summarizeConversationPrompt(input);
    const generate = agentGenerate(
      'summarize-conversation',
      await this.resolveModel('summarizeConversation'),
    );
    return generateStructured(generate, 'summarize-conversation', prompt, ConversationSummaryDraft);
  }
}

/** The recent messages as the chat itself. Tool calls and results reach the AI from 0043 on. */
function toAgentMessages(messages: ChatMessageForAi[]) {
  return messages.map((m) => {
    if (m.role === 'USER') return { role: 'user' as const, content: m.content };
    if (m.role === 'ASSISTANT') return { role: 'assistant' as const, content: m.content };
    return {
      role: 'user' as const,
      content: `(Result of tool call ${m.toolCallId})\n${m.content}`,
    };
  });
}

/** A Conversation reply: plain text streamed as written, one model step, no server-side tools. */
async function* streamChat(
  model: MastraModel,
  instructions: string,
  messages: ChatMessageForAi[],
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  const agent = new Agent({ id: 'chat', name: 'chat', instructions, model: model as AgentModel });
  const output = await agent.stream(toAgentMessages(messages), {
    maxSteps: 1,
    ...(signal ? { abortSignal: signal } : {}),
  });
  for await (const chunk of output.fullStream) {
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

const PingResult = z.object({ reply: z.string() });

/** A tiny structured call to check that a provider config works. */
export async function pingModel(model: MastraModel): Promise<void> {
  const generate = agentGenerate('connection-test', model);
  const raw = await generate('Reply with the single word "ok" in the `reply` field.', PingResult);
  PingResult.parse(raw);
}
