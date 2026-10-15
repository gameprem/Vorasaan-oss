// Plain values of enums.ts, with no Zod, so the web pages that use them don't load Zod.

export const TEAM_ROLES = [
  'PO',
  'DESIGNER',
  'TECH_LEAD',
  'BACKEND',
  'FRONTEND',
  'MOBILE',
  'QA',
] as const;

export const CHAT_EVENT_KINDS = [
  'DECISION_REQUEST',
  'NEEDS_INFO',
  'SPEC_PROPOSAL',
  'ESCALATION',
] as const;
