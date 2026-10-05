import type { AiTask } from '@vorasaan/shared';

/** The AI tasks an Admin sets a model for (AI models), as Settings names them. */
export const TASK_LABEL: Record<AiTask, { label: string; hint: string }> = {
  CHOICES: { label: 'Choices', hint: 'Options suggested for a Decision Request' },
  SPEC_PROPOSAL: {
    label: 'Spec Proposals',
    hint: 'Spec changes after a Decision, or a first Spec',
  },
  SUMMARIES: { label: 'Summaries', hint: 'Attachment and Conversation summaries' },
  GRILLING: { label: 'Grilling', hint: 'Questions, and the Brief Proposal from the answers' },
  FEATURE_SUGGESTIONS: { label: 'Feature Suggestions', hint: 'Features proposed from the Brief' },
  FIT_CHECK: { label: 'Fit check', hint: 'A new Feature against the Feature Guidelines' },
  CHAT: { label: 'Chat', hint: 'Replies in Conversations' },
  PROMPT_PROPOSALS: {
    label: 'Prompt proposals',
    hint: 'Reading feedback on a prompt and proposing a Prompt Version',
  },
};
