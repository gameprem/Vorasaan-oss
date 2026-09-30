// Shared class names so buttons and fields look the same everywhere.
export const primaryButton =
  'rounded-lg bg-ink px-4 py-2 font-medium text-sheet disabled:cursor-not-allowed disabled:opacity-40';
export const secondaryButton =
  'rounded-lg border border-rule bg-sheet px-4 py-2 font-medium text-ink disabled:opacity-40';
export const field =
  'mt-1 w-full rounded-lg border border-rule bg-sheet px-3 py-2 text-ink placeholder:text-ink-soft/60';
export const ROLE_LABEL = {
  PO: 'PO',
  DESIGNER: 'Designer',
  TECH_LEAD: 'Tech Lead',
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobile',
  QA: 'QA',
} as const;
export const ROUND_LABEL = { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' } as const;
