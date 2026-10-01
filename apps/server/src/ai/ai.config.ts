// Model per AI task, in Mastra's "provider/model" form. Changing a model is a
// config change: set the env var. Anthropic models read ANTHROPIC_API_KEY.
export const DEFAULT_MODEL = 'anthropic/claude-opus-5-5';

export type AiConfig = {
  generateChoicesModel: string;
  draftSpecProposalModel: string;
  summarizeAttachmentModel: string;
  draftSpecFromAttachmentsModel: string;
  grillingQuestionsModel: string;
  draftBriefFromGrillingModel: string;
  suggestFeaturesModel: string;
  draftSpecFromSuggestionModel: string;
  checkFeatureFitModel: string;
  chatModel: string;
  summarizeConversationModel: string;
};

export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const fallback = env.VORASAAN_MODEL ?? DEFAULT_MODEL;
  return {
    generateChoicesModel: env.VORASAAN_MODEL_GENERATE_CHOICES ?? fallback,
    draftSpecProposalModel: env.VORASAAN_MODEL_DRAFT_SPEC_PROPOSAL ?? fallback,
    summarizeAttachmentModel: env.VORASAAN_MODEL_SUMMARIZE_ATTACHMENT ?? fallback,
    draftSpecFromAttachmentsModel: env.VORASAAN_MODEL_DRAFT_SPEC_FROM_ATTACHMENTS ?? fallback,
    grillingQuestionsModel: env.VORASAAN_MODEL_GRILLING_QUESTIONS ?? fallback,
    draftBriefFromGrillingModel: env.VORASAAN_MODEL_DRAFT_BRIEF_FROM_GRILLING ?? fallback,
    suggestFeaturesModel: env.VORASAAN_MODEL_SUGGEST_FEATURES ?? fallback,
    draftSpecFromSuggestionModel: env.VORASAAN_MODEL_DRAFT_SPEC_FROM_SUGGESTION ?? fallback,
    checkFeatureFitModel: env.VORASAAN_MODEL_CHECK_FEATURE_FIT ?? fallback,
    chatModel: env.VORASAAN_MODEL_CHAT ?? fallback,
    summarizeConversationModel: env.VORASAAN_MODEL_SUMMARIZE_CONVERSATION ?? fallback,
  };
}
