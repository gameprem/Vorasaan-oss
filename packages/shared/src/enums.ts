import { z } from 'zod';

// Mirrors of the Prisma enums (packages/db/prisma/schema.prisma).
// enums.test.ts fails if the two drift apart.

export const OrgRole = z.enum(['ADMIN', 'MEMBER']);
export type OrgRole = z.infer<typeof OrgRole>;

export const TeamRole = z.enum([
  'PO',
  'DESIGNER',
  'TECH_LEAD',
  'BACKEND',
  'FRONTEND',
  'MOBILE',
  'QA',
]);
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

export const SpecVersionSource = z.enum(['MANUAL', 'AI_SUMMARY', 'DECISION', 'REVERT']);
export type SpecVersionSource = z.infer<typeof SpecVersionSource>;

export const BriefVersionSource = z.enum(['MANUAL', 'GRILLING', 'REVERT']);
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
