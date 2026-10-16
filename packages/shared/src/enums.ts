import { z } from 'zod';
import { CHAT_EVENT_KINDS, TEAM_ROLES } from './enums-values.ts';

// Mirrors of the Prisma enums (packages/db/prisma/schema.prisma).
// enums.test.ts fails if the two drift apart.

export const OrgRole = z.enum(['ADMIN', 'MEMBER']);
export type OrgRole = z.infer<typeof OrgRole>;

export const TeamRole = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof TeamRole>;

export const DecisionRequestKind = z.enum(['BLOCKER', 'QUESTION']);
export type DecisionRequestKind = z.infer<typeof DecisionRequestKind>;

export const DecisionRequestStatus = z.enum([
  'DRAFT',
  'OPEN',
  'NEEDS_INFO',
  'DECIDED',
  'SPEC_UPDATED',
  'WITHDRAWN',
]);
export type DecisionRequestStatus = z.infer<typeof DecisionRequestStatus>;

export const RequestMessageKind = z.enum(['QUESTION', 'ANSWER', 'NOTE']);
export type RequestMessageKind = z.infer<typeof RequestMessageKind>;

export const ProposalStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const SpecVersionSource = z.enum([
  'MANUAL',
  'AI_SUMMARY',
  'DECISION',
  'REVERT',
  'CONVERSATION',
  'ACCEPTANCE_CRITERIA',
]);
export type SpecVersionSource = z.infer<typeof SpecVersionSource>;

export const BriefVersionSource = z.enum(['MANUAL', 'GRILLING', 'REVERT', 'CONVERSATION']);
export type BriefVersionSource = z.infer<typeof BriefVersionSource>;

export const GuidelineCriterionKind = z.enum(['KPI', 'CONSTRAINT', 'REQUIRED_SECTION']);
export type GuidelineCriterionKind = z.infer<typeof GuidelineCriterionKind>;

export const AttachmentSource = z.enum(['FILE', 'URL', 'CONFLUENCE', 'JIRA', 'REPO_SCAN']);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

export const NotificationType = z.enum([
  'REQUEST_DECIDED',
  'REQUEST_CLAIMED',
  'REQUEST_WITHDRAWN',
  'SPEC_VERSION_CREATED',
  'DELEGATION_STARTED',
  'REQUEST_REMINDER',
  'REQUEST_ESCALATED',
  'REQUEST_OVERDUE',
  'AI_BUDGET_WARNING',
  'AI_BUDGET_REACHED',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const GrillingStatus = z.enum(['RUNNING', 'DRAFTED', 'CANCELLED']);
export type GrillingStatus = z.infer<typeof GrillingStatus>;

export const GrillingRoundKind = z.enum(['BUSINESS', 'UX', 'TECHNICAL']);
export type GrillingRoundKind = z.infer<typeof GrillingRoundKind>;

export const GrillingRoundStatus = z.enum(['ASKING', 'ANSWERED', 'SKIPPED']);
export type GrillingRoundStatus = z.infer<typeof GrillingRoundStatus>;

export const GrillingSkipReason = z.enum(['NO_ONE_WITH_ROLE', 'NOTHING_TO_ASK', 'BY_STARTER']);
export type GrillingSkipReason = z.infer<typeof GrillingSkipReason>;

export const FeatureSuggestionStatus = z.enum(['PENDING', 'ACCEPTED', 'DISMISSED']);
export type FeatureSuggestionStatus = z.infer<typeof FeatureSuggestionStatus>;

export const SuggestionLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type SuggestionLevel = z.infer<typeof SuggestionLevel>;

export const FeatureStatus = z.enum(['DRAFT', 'IN_PROGRESS', 'DONE', 'ARCHIVED']);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const ConversationMessageRole = z.enum(['USER', 'ASSISTANT', 'TOOL']);
export type ConversationMessageRole = z.infer<typeof ConversationMessageRole>;

export const ActionCardKind = z.enum([
  'DECISION_REQUEST',
  'SPEC_PROPOSAL',
  'BRIEF_PROPOSAL',
  'FEATURE_SUGGESTION',
]);
export type ActionCardKind = z.infer<typeof ActionCardKind>;

export const ActionCardStatus = z.enum(['PROPOSED', 'APPROVED', 'DECLINED', 'STALE']);
export type ActionCardStatus = z.infer<typeof ActionCardStatus>;

export const ResponseWindowUnit = z.enum(['WORKING_HOURS', 'WORKING_DAYS']);
export type ResponseWindowUnit = z.infer<typeof ResponseWindowUnit>;

export const RequestHistoryKind = z.enum(['REMINDED', 'DELEGATES_ADDED', 'OVERDUE_REPORTED']);
export type RequestHistoryKind = z.infer<typeof RequestHistoryKind>;

export const ChatProvider = z.enum(['LINE', 'SLACK', 'TEAMS']);
export type ChatProvider = z.infer<typeof ChatProvider>;

export const ChatEventKind = z.enum(CHAT_EVENT_KINDS);
export type ChatEventKind = z.infer<typeof ChatEventKind>;

export const DecisionSource = z.enum(['WEB', 'CLI', 'LINE', 'SLACK', 'TEAMS']);
export type DecisionSource = z.infer<typeof DecisionSource>;

export const ChatCardStatus = z.enum(['PENDING', 'SENT', 'SKIPPED', 'FAILED']);
export type ChatCardStatus = z.infer<typeof ChatCardStatus>;

export const ProposalKind = z.enum([
  'CHOICES',
  'SPEC_PROPOSAL',
  'BRIEF_PROPOSAL',
  'FEATURE_SUGGESTION',
  'PROMPT_VERSION',
  'DESIGN_DOC_PROPOSAL',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const RedraftStatus = z.enum(['WRITING', 'READY']);
export type RedraftStatus = z.infer<typeof RedraftStatus>;

export const ReceiptOutputKind = z.enum([
  'CHOICES',
  'SPEC_PROPOSAL',
  'BRIEF_PROPOSAL',
  'FEATURE_SUGGESTION_BATCH',
  'REDRAFT',
  'CONVERSATION_MESSAGE',
  'CONVERSATION',
  'ATTACHMENT',
  'GRILLING_ROUND',
  'GRILLING_QUESTION',
  'PROMPT_ANALYSIS',
  'PROMPT_VERSION',
  'DESIGN_DOC_PROPOSAL',
]);
export type ReceiptOutputKind = z.infer<typeof ReceiptOutputKind>;

export const ReceiptOutcomeKind = z.enum(['APPROVE', 'DECLINE', 'REQUEST_CHANGES', 'MANUAL_EDIT']);
export type ReceiptOutcomeKind = z.infer<typeof ReceiptOutcomeKind>;

export const PromptVersionStatus = z.enum(['PROPOSED', 'APPROVED', 'DECLINED']);
export type PromptVersionStatus = z.infer<typeof PromptVersionStatus>;

export const PromptActivationKind = z.enum(['APPROVE', 'ROLLBACK']);
export type PromptActivationKind = z.infer<typeof PromptActivationKind>;

export const PromptEvalRunStatus = z.enum(['RUNNING', 'DONE', 'FAILED']);
export type PromptEvalRunStatus = z.infer<typeof PromptEvalRunStatus>;

export const PromptAnalysisStatus = z.enum(['RUNNING', 'DONE', 'FAILED']);
export type PromptAnalysisStatus = z.infer<typeof PromptAnalysisStatus>;

export const PromptAnalysisTrigger = z.enum(['MANUAL', 'FEEDBACK']);
export type PromptAnalysisTrigger = z.infer<typeof PromptAnalysisTrigger>;

/** The template a Design Doc starts from (ticket 0069): one per kind of Platform, and QA's. */
export const DesignTemplateKind = z.enum(['BACK_END', 'FRONT_END', 'MOBILE', 'QA']);
export type DesignTemplateKind = z.infer<typeof DesignTemplateKind>;

export const DesignDocVersionSource = z.enum(['AI_DRAFT', 'REVERT']);
export type DesignDocVersionSource = z.infer<typeof DesignDocVersionSource>;

export const DesignDocProposalReason = z.enum(['FIRST_DRAFT', 'SPEC_CHANGED']);
export type DesignDocProposalReason = z.infer<typeof DesignDocProposalReason>;

export const DesignDocProposalStatus = z.enum(['PENDING', 'APPROVED', 'DECLINED', 'SUPERSEDED']);
export type DesignDocProposalStatus = z.infer<typeof DesignDocProposalStatus>;
