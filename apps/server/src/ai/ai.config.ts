import type { AiTask as AiTaskKind } from '@vorasaan/shared';

// The model of an AI call is normally an Approved Model chosen in Settings
// (ADR 0010). Env vars still apply, in Mastra's "provider/model" form:
// - VORASAAN_MODEL_<TASK> wins over Settings for that task when it is set;
// - VORASAAN_MODEL (default anthropic/claude-opus-5-5) is used only while the
//   Organization has no Approved Model (development, before setup).
export const DEFAULT_MODEL = 'anthropic/claude-opus-5-5';

/** Each kind of AI call the server makes. */
export type AiTask =
  | 'generateChoices'
  | 'draftSpecProposal'
  | 'summarizeAttachment'
  | 'draftSpecFromAttachments'
  | 'grillingQuestions'
  | 'grillingFollowUp'
  | 'draftBriefFromGrilling'
  | 'suggestFeatures'
  | 'draftSpecFromSuggestion'
  | 'checkFeatureFit'
  | 'draftAcceptanceCriteria'
  | 'chat'
  | 'summarizeConversation'
  | 'redraftChoices'
  | 'redraftSpecProposal'
  | 'redraftBriefProposal'
  | 'redraftFeatureSuggestion'
  | 'analyzeFeedback'
  | 'proposePromptVersion'
  | 'redraftPromptVersion'
  | 'draftDesignDoc'
  | 'redraftDesignDoc';

/** The Settings task each call belongs to, and the env var that overrides its model. */
export const AI_TASKS: Record<AiTask, { kind: AiTaskKind; env: string }> = {
  generateChoices: { kind: 'CHOICES', env: 'VORASAAN_MODEL_GENERATE_CHOICES' },
  draftSpecProposal: { kind: 'SPEC_PROPOSAL', env: 'VORASAAN_MODEL_DRAFT_SPEC_PROPOSAL' },
  summarizeAttachment: { kind: 'SUMMARIES', env: 'VORASAAN_MODEL_SUMMARIZE_ATTACHMENT' },
  draftSpecFromAttachments: {
    kind: 'SPEC_PROPOSAL',
    env: 'VORASAAN_MODEL_DRAFT_SPEC_FROM_ATTACHMENTS',
  },
  grillingQuestions: { kind: 'GRILLING', env: 'VORASAAN_MODEL_GRILLING_QUESTIONS' },
  grillingFollowUp: { kind: 'GRILLING', env: 'VORASAAN_MODEL_GRILLING_FOLLOW_UP' },
  draftBriefFromGrilling: { kind: 'GRILLING', env: 'VORASAAN_MODEL_DRAFT_BRIEF_FROM_GRILLING' },
  suggestFeatures: { kind: 'FEATURE_SUGGESTIONS', env: 'VORASAAN_MODEL_SUGGEST_FEATURES' },
  draftSpecFromSuggestion: {
    kind: 'SPEC_PROPOSAL',
    env: 'VORASAAN_MODEL_DRAFT_SPEC_FROM_SUGGESTION',
  },
  checkFeatureFit: { kind: 'FIT_CHECK', env: 'VORASAAN_MODEL_CHECK_FEATURE_FIT' },
  // Coverage (ticket 0051): a Platform's acceptance criteria, drafted as a Spec Proposal.
  draftAcceptanceCriteria: {
    kind: 'SPEC_PROPOSAL',
    env: 'VORASAAN_MODEL_DRAFT_ACCEPTANCE_CRITERIA',
  },
  chat: { kind: 'CHAT', env: 'VORASAAN_MODEL_CHAT' },
  summarizeConversation: { kind: 'SUMMARIES', env: 'VORASAAN_MODEL_SUMMARIZE_CONVERSATION' },
  // Request changes (ticket 0065): a Redraft runs on the model of the task that drafted it.
  redraftChoices: { kind: 'CHOICES', env: 'VORASAAN_MODEL_REDRAFT_CHOICES' },
  redraftSpecProposal: { kind: 'SPEC_PROPOSAL', env: 'VORASAAN_MODEL_REDRAFT_SPEC_PROPOSAL' },
  redraftBriefProposal: { kind: 'GRILLING', env: 'VORASAAN_MODEL_REDRAFT_BRIEF_PROPOSAL' },
  redraftFeatureSuggestion: {
    kind: 'FEATURE_SUGGESTIONS',
    env: 'VORASAAN_MODEL_REDRAFT_FEATURE_SUGGESTION',
  },
  // The Learning Loop (ticket 0072): reading a prompt's feedback and proposing a version of it.
  analyzeFeedback: { kind: 'PROMPT_PROPOSALS', env: 'VORASAAN_MODEL_ANALYZE_FEEDBACK' },
  proposePromptVersion: { kind: 'PROMPT_PROPOSALS', env: 'VORASAAN_MODEL_PROPOSE_PROMPT_VERSION' },
  redraftPromptVersion: { kind: 'PROMPT_PROPOSALS', env: 'VORASAAN_MODEL_REDRAFT_PROMPT_VERSION' },
  // Design Docs (ticket 0069): drafted from the approved Spec, and redrafted on request.
  draftDesignDoc: { kind: 'DESIGN_DOCS', env: 'VORASAAN_MODEL_DRAFT_DESIGN_DOC' },
  redraftDesignDoc: { kind: 'DESIGN_DOCS', env: 'VORASAAN_MODEL_REDRAFT_DESIGN_DOC' },
};

/** The per-task env override, or undefined when it isn't set. */
export function envModelOverride(
  task: AiTask,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[AI_TASKS[task].env]?.trim() || undefined;
}

/** The env vars set for one Settings task (shown in Settings, since they win). */
export function envOverridesFor(
  kind: AiTaskKind,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.values(AI_TASKS)
    .filter((t) => t.kind === kind && env[t.env]?.trim())
    .map((t) => t.env);
}

/** The model while no Approved Model exists. */
export function envFallbackModel(env: Record<string, string | undefined> = process.env): string {
  return env.VORASAAN_MODEL?.trim() || DEFAULT_MODEL;
}

export type AiConfig = Record<`${AiTask}Model`, string>;

/**
 * The model of every task from env alone, as the eval scripts run it (no
 * database): VORASAAN_MODEL_<TASK>, else VORASAAN_MODEL, else the default.
 */
export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const fallback = env.VORASAAN_MODEL ?? DEFAULT_MODEL;
  return Object.fromEntries(
    (Object.keys(AI_TASKS) as AiTask[]).map((task) => [
      `${task}Model`,
      env[AI_TASKS[task].env] ?? fallback,
    ]),
  ) as AiConfig;
}
