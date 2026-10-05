import type { AiTask } from '../ai/ai.config.ts';

// The eval guard of ticket 0076, like the query budgets of 0074: what each AI task's prompt
// costs after its optimizations, by the script-aware estimate (ticket 0059), and the scores
// it keeps. `token-guard.test.ts` and `token-scenarios.api.test.ts` fail when a task's
// prompts grow past these or a score drops below them. Lower a number when a change saves
// tokens; raise one only on purpose, saying why in its ticket. `bun run tokens:tasks`
// prints the same measures. Scores here are what the FakeAiPort can show (a valid answer,
// kept texts, injections not followed, the replay's similarity); a real model's are
// measured by hand with `bun run eval:*`.

/**
 * The checked-in eval cases of each task: mean prompt tokens, and their scores (Thai apart).
 * Ticket 0051 gave the AI Coverage: draftSpecFromAttachments (1296 before) and
 * grillingQuestions (1235 before) gained a rule and a <platforms> block, about 60 tokens a
 * call on the earlier cases, and both sets gained Coverage cases (cases/coverage.ts), which
 * also gave draftSpecProposal checked-in cases (and a guard) for the first time.
 */
export const EVAL_CASE_GUARD: Record<AiTask, { tokens: number; score: number; thai?: number }> = {
  generateChoices: { tokens: 1602, score: 0.7, thai: 0.399 },
  draftSpecProposal: { tokens: 1453, score: 1, thai: 1 },
  summarizeAttachment: { tokens: 863, score: 0.8, thai: 0.2 },
  draftSpecFromAttachments: { tokens: 1337, score: 0.76, thai: 0.4 },
  grillingQuestions: { tokens: 1255, score: 0.833, thai: 0.5 },
  grillingFollowUp: { tokens: 984, score: 0.714, thai: 0.5 },
  draftBriefFromGrilling: { tokens: 1685, score: 0.666, thai: 1 },
  suggestFeatures: { tokens: 1450, score: 0.722, thai: 0.583 },
  draftSpecFromSuggestion: { tokens: 1254, score: 1, thai: 1 },
  checkFeatureFit: { tokens: 1315, score: 0.708, thai: 0.333 },
  draftAcceptanceCriteria: { tokens: 1345, score: 1, thai: 1 },
  chat: { tokens: 1616, score: 0.82, thai: 0.55 },
  summarizeConversation: { tokens: 1533, score: 0.916, thai: 0.916 },
  redraftChoices: { tokens: 1840, score: 0.833, thai: 0.666 },
  redraftSpecProposal: { tokens: 1853, score: 0.8, thai: 0.833 },
  redraftBriefProposal: { tokens: 1304, score: 0.9, thai: 0.8 },
  redraftFeatureSuggestion: { tokens: 1247, score: 0.666, thai: 0.666 },
  analyzeFeedback: { tokens: 2112, score: 0.888, thai: 0.666 },
  proposePromptVersion: { tokens: 2018, score: 1 },
  redraftPromptVersion: { tokens: 3087, score: 0.666 },
};

/**
 * The product's own calls on the small large Organization (`token-scenarios.ts`): mean
 * input tokens per call of each task, from their Receipts. Before ticket 0076 they were
 * generateChoices 13,314, draftSpecProposal 13,148, draftSpecFromAttachments 31,016,
 * grillingQuestions 8,531, suggestFeatures 10,719, draftSpecFromSuggestion 8,393,
 * checkFeatureFit 8,397, chat 12,734, redraftChoices 13,557, redraftSpecProposal 13,429,
 * redraftFeatureSuggestion 8,615.
 *
 * Ticket 0051 raised them on purpose. The large Organization's Features now target Platforms
 * whose sections their Specs lack, so draftSpecProposal and draftSpecFromAttachments get a
 * <platforms> block, Grilling the Platforms no Feature covers (9057, 27809 and 7892 before),
 * and the approved Spec Proposal gives the seeded Spec a section per Platform, which every
 * later call reads in its context: generateChoices (9370), suggestFeatures (7992),
 * draftSpecFromSuggestion (7755), checkFeatureFit (6557), chat (10034), redraftSpecProposal
 * (9335) and redraftFeatureSuggestion (7977) grew by that Spec, by 21 to 102 tokens a call.
 * draftAcceptanceCriteria is new.
 */
export const PRODUCT_TOKEN_GUARD: Partial<Record<AiTask, number>> = {
  generateChoices: 9391,
  draftSpecProposal: 9187,
  draftSpecFromAttachments: 27912,
  grillingQuestions: 8063,
  suggestFeatures: 8094,
  draftSpecFromSuggestion: 7856,
  checkFeatureFit: 6659,
  draftAcceptanceCriteria: 9819,
  chat: 10095,
  redraftChoices: 9127,
  redraftSpecProposal: 9377,
  redraftFeatureSuggestion: 8078,
};

/** The replay of the approved Receipts in those calls (ticket 0071): its score on the fake. */
export const REPLAY_SCORE_GUARD = {
  'generate-choices': 0.959,
  'draft-spec-proposal': 0.989,
} as const;
