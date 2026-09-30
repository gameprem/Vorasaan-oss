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

export const AttachmentSource = z.enum(['FILE', 'URL', 'CONFLUENCE', 'JIRA']);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

export const NotificationType = z.enum([
  'REQUEST_DECIDED',
  'REQUEST_CLAIMED',
  'REQUEST_WITHDRAWN',
  'SPEC_VERSION_CREATED',
  'DELEGATION_STARTED',
]);
export type NotificationType = z.infer<typeof NotificationType>;
