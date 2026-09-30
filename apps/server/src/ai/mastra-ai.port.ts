import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import {
  type AiPort,
  type DecisionForAi,
  GeneratedChoices,
  type RequestForAi,
  SpecProposalDraft,
} from './ai.port.ts';
import type { MastraModel } from './model-config.ts';
import { draftSpecProposalPrompt, generateChoicesPrompt } from './prompts.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';

const INSTRUCTIONS =
  'You are Vorasaan, an assistant that helps software teams align on what to build. ' +
  'Follow the task instructions exactly and return only the requested structure.';

export type AiTask = 'generateChoices' | 'draftSpecProposal';

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

  async generateChoices(input: { specMarkdown: string; request: RequestForAi }) {
    const prompt = await generateChoicesPrompt(input.specMarkdown, input.request);
    const generate = agentGenerate('generate-choices', await this.resolveModel('generateChoices'));
    return generateStructured(generate, 'generate-choices', prompt, GeneratedChoices);
  }

  async draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
  }) {
    const prompt = await draftSpecProposalPrompt(input.specMarkdown, input.request, input.decision);
    const generate = agentGenerate(
      'draft-spec-proposal',
      await this.resolveModel('draftSpecProposal'),
    );
    return generateStructured(generate, 'draft-spec-proposal', prompt, SpecProposalDraft);
  }
}

const PingResult = z.object({ reply: z.string() });

/** A tiny structured call to check that a provider config works. */
export async function pingModel(model: MastraModel): Promise<void> {
  const generate = agentGenerate('connection-test', model);
  const raw = await generate('Reply with the single word "ok" in the `reply` field.', PingResult);
  PingResult.parse(raw);
}
