/** What a Decision says, as indexed for retrieval and shown to the AI as context. */
export type DecisionForText = {
  customAnswer: string | null;
  rationale: string | null;
  choice: { label: string; title: string; description: string } | null;
  request: { title: string; description: string };
};

export function decisionText(decision: DecisionForText): string {
  const outcome = decision.choice
    ? `Choice ${decision.choice.label}: ${decision.choice.title}\n\n${decision.choice.description}`
    : (decision.customAnswer ?? '');
  return [
    `# Decision: ${decision.request.title}`,
    decision.request.description,
    `## Decided\n${outcome}`,
    decision.rationale ? `## Rationale\n${decision.rationale}` : '',
  ]
    .filter((part) => part.trim())
    .join('\n\n');
}
