import { Agent } from '@mastra/core/agent';
import type { AiConfig } from './ai.config.ts';
import {
  type AiPort,
  type DecisionForAi,
  GeneratedChoices,
  type RequestForAi,
  SpecProposalDraft,
} from './ai.port.ts';
import { draftSpecProposalPrompt, generateChoicesPrompt } from './prompts.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';

const INSTRUCTIONS =
  'You are Vorasaan, an assistant that helps software teams align on what to build. ' +
  'Follow the task instructions exactly and return only the requested structure.';

function agentGenerate(agent: Agent): StructuredGenerate {
  return async (prompt, schema) => {
    const result = await agent.generate(prompt, { structuredOutput: { schema } });
    return result.object;
  };
}

// Mastra used as a library (ADR 0003): no Mastra server, no storage needed yet.
export class MastraAiPort implements AiPort {
  private readonly choices: StructuredGenerate;
  private readonly specProposal: StructuredGenerate;

  constructor(config: AiConfig) {
    this.choices = agentGenerate(
      new Agent({
        id: 'generate-choices',
        name: 'Choice generator',
        instructions: INSTRUCTIONS,
        model: config.generateChoicesModel,
      }),
    );
    this.specProposal = agentGenerate(
      new Agent({
        id: 'draft-spec-proposal',
        name: 'Spec Proposal drafter',
        instructions: INSTRUCTIONS,
        model: config.draftSpecProposalModel,
      }),
    );
  }

  async generateChoices(input: { specMarkdown: string; request: RequestForAi }) {
    const prompt = await generateChoicesPrompt(input.specMarkdown, input.request);
    return generateStructured(this.choices, 'generate-choices', prompt, GeneratedChoices);
  }

  async draftSpecProposal(input: {
    specMarkdown: string;
    request: RequestForAi;
    decision: DecisionForAi;
  }) {
    const prompt = await draftSpecProposalPrompt(input.specMarkdown, input.request, input.decision);
    return generateStructured(this.specProposal, 'draft-spec-proposal', prompt, SpecProposalDraft);
  }
}
