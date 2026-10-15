// Shared class names so buttons and fields look the same everywhere.
export const primaryButton =
  'rounded-full bg-ink px-4 py-2 font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
export const secondaryButton =
  'rounded-full bg-surface px-4 py-2 font-semibold text-fg hover:bg-surface-hi disabled:opacity-40';
export const field =
  'mt-1 w-full rounded-tile bg-surface ring-1 ring-inset ring-line px-3 py-2 text-fg placeholder:text-fg-soft';
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
