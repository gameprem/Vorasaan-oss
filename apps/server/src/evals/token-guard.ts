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
 *
 * Ticket 0078 gave chat five Agent Skills cases (cases/agent-skills.ts): their prompts list two
 * Skills and offer two more tools, and four of them carry a loaded SKILL.md (and an SVG) as tool
 * results, about 2,900 tokens each. The five earlier chat cases are unchanged (1616, scores
 * 0.82 and Thai 0.55): a Project without Skills renders nothing for them. With the new cases
 * chat's mean is 2261, its score 0.91 and Thai 0.775.
 *
 * 2026-10-14, ticket 0080: Thai rules tightened after real-model evals (Gemini); +62 or +63
 * tokens per call. The language partial every prompt carries now names product, library
 * and protocol names, acronyms, ticket keys and versions among the kept terms, says every
 * Thai sentence is written in Thai, and ends with a self-check. Before: generateChoices
 * 1602, draftSpecProposal 1453, summarizeAttachment 863, draftSpecFromAttachments 1337,
 * grillingQuestions 1255, grillingFollowUp 984, draftBriefFromGrilling 1685, suggestFeatures
 * 1450, draftSpecFromSuggestion 1254, checkFeatureFit 1315, draftAcceptanceCriteria 1345,
 * chat 2261, summarizeConversation 1533, redraftChoices 1840, redraftSpecProposal 1853,
 * redraftBriefProposal 1304, redraftFeatureSuggestion 1247, analyzeFeedback 2112,
 * proposePromptVersion 2018, redraftPromptVersion 3087, draftDesignDoc 1897,
 * redraftDesignDoc 1873. Scores on the fake unchanged, Thai included.
 */
export const EVAL_CASE_GUARD: Record<AiTask, { tokens: number; score: number; thai?: number }> = {
  generateChoices: { tokens: 1664, score: 0.7, thai: 0.399 },
  draftSpecProposal: { tokens: 1516, score: 1, thai: 1 },
  summarizeAttachment: { tokens: 925, score: 0.8, thai: 0.2 },
  draftSpecFromAttachments: { tokens: 1400, score: 0.76, thai: 0.4 },
  grillingQuestions: { tokens: 1318, score: 0.833, thai: 0.5 },
  grillingFollowUp: { tokens: 1046, score: 0.714, thai: 0.5 },
  draftBriefFromGrilling: { tokens: 1748, score: 0.666, thai: 1 },
  suggestFeatures: { tokens: 1513, score: 0.722, thai: 0.583 },
  draftSpecFromSuggestion: { tokens: 1317, score: 1, thai: 1 },
  checkFeatureFit: { tokens: 1378, score: 0.708, thai: 0.333 },
  draftAcceptanceCriteria: { tokens: 1408, score: 1, thai: 1 },
  chat: { tokens: 2324, score: 0.909, thai: 0.775 },
  summarizeConversation: { tokens: 1596, score: 0.916, thai: 0.916 },
  redraftChoices: { tokens: 1903, score: 0.833, thai: 0.666 },
  redraftSpecProposal: { tokens: 1916, score: 0.8, thai: 0.833 },
  redraftBriefProposal: { tokens: 1367, score: 0.9, thai: 0.8 },
  redraftFeatureSuggestion: { tokens: 1310, score: 0.666, thai: 0.666 },
  analyzeFeedback: { tokens: 2175, score: 0.888, thai: 0.666 },
  proposePromptVersion: { tokens: 2081, score: 1 },
  redraftPromptVersion: { tokens: 3149, score: 0.666 },
  // Ticket 0069: new, with their cases (cases/design-docs.ts).
  draftDesignDoc: { tokens: 1960, score: 1, thai: 1 },
  redraftDesignDoc: { tokens: 1936, score: 1, thai: 1 },
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
 *
 * 2026-10-14, ticket 0080: Thai rules tightened after real-model evals (Gemini); +62 or +63
 * tokens per call (the language partial, above). Before: generateChoices 9391,
 * draftSpecProposal 9187, draftSpecFromAttachments 27912, grillingQuestions 8063,
 * suggestFeatures 8094, draftSpecFromSuggestion 7856, checkFeatureFit 6659,
 * draftAcceptanceCriteria 9819, chat 10095, redraftChoices 9127, redraftSpecProposal 9377,
 * redraftFeatureSuggestion 8078, draftDesignDoc 10478, redraftDesignDoc 11197.
 */
export const PRODUCT_TOKEN_GUARD: Partial<Record<AiTask, number>> = {
  generateChoices: 9454,
  draftSpecProposal: 9250,
  draftSpecFromAttachments: 27974,
  grillingQuestions: 8125,
  suggestFeatures: 8157,
  draftSpecFromSuggestion: 7919,
  checkFeatureFit: 6721,
  draftAcceptanceCriteria: 9882,
  chat: 10158,
  redraftChoices: 9189,
  redraftSpecProposal: 9440,
  redraftFeatureSuggestion: 8141,
  // Ticket 0069: new. The scenarios end with the Back-End Design Doc drafted from the Spec
  // (and QA's) and one Redraft of it.
  draftDesignDoc: 10540,
  redraftDesignDoc: 11260,
};

/** The replay of the approved Receipts in those calls (ticket 0071): its score on the fake. */
export const REPLAY_SCORE_GUARD = {
  'generate-choices': 0.959,
  'draft-spec-proposal': 0.989,
} as const;
