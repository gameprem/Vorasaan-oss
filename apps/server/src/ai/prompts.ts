import { renderSkill } from '@vorasaan/skills';
import type { DecisionForAi, RequestForAi } from './ai.port.ts';

const KIND_MEANING = {
  BLOCKER: "the Raiser's work is stopped until this is decided",
  QUESTION: 'the Raiser can keep working meanwhile',
} as const;

export function generateChoicesPrompt(specMarkdown: string, request: RequestForAi) {
  return renderSkill('generate-choices', {
    spec: specMarkdown,
    kind: request.kind,
    kindMeaning: KIND_MEANING[request.kind],
    raiserRole: request.raiserRole,
    title: request.title,
    description: request.description,
  });
}

export function describeDecision(decision: DecisionForAi): string {
  const main =
    decision.kind === 'choice'
      ? [
          `Picked Choice ${decision.choice.label}: ${decision.choice.title}`,
          decision.choice.description,
          `Scope: ${decision.choice.impactScope}`,
        ].join('\n')
      : `Answered in their own words: ${decision.answer}`;
  return decision.rationale ? `${main}\nRationale: ${decision.rationale}` : main;
}

export function draftSpecProposalPrompt(
  specMarkdown: string,
  request: RequestForAi,
  decision: DecisionForAi,
) {
  return renderSkill('draft-spec-proposal', {
    spec: specMarkdown,
    kind: request.kind,
    title: request.title,
    description: request.description,
    decision: describeDecision(decision),
  });
}
