// A large, multi-document Project where the answer to one question sits in a
// single paragraph of one long Attachment. Used by the retrieval tests (with the
// fake embeddings and the keyword fallback) and by the manual eval
// (scripts/eval-retrieval.ts) against the real model. Deterministic: no randomness.

/** The paragraph that answers the question, somewhere in the middle of the handbook. */
export const NEEDLE_PARAGRAPH =
  'PromptPay settlements close at 22:30 Bangkok time. A payout batch submitted after ' +
  'this cutoff is paid on the next business day, and the bank charges 12 THB for every ' +
  'late batch, so the payout scheduler must submit by 22:15 at the latest.';

/** The question, as a Decision Request would ask it. */
export const NEEDLE_QUESTION = {
  title: 'When is the PromptPay settlement cutoff?',
  description:
    'Payout batches sometimes reach the bank late. What cutoff should the payout scheduler use, and what does a late batch cost?',
};

/** What a good answer must mention. */
export const NEEDLE_FACTS = ['22:30', '12 THB'];

/**
 * Unrelated handbook topics, each with its own vocabulary, so only the needle
 * section shares words with the question.
 */
const TOPICS: [heading: string, sentence: string][] = [
  ['Office access', 'Visitors sign the guest register at reception and wear a red lanyard.'],
  ['Laptop encryption', 'Every laptop uses full disk encryption with a recovery key in escrow.'],
  ['On-call rotation', 'Engineers rotate weekly and hand over the pager every Monday morning.'],
  ['Support tone', 'Agents greet customers warmly, avoid jargon and never blame the customer.'],
  ['Brand colours', 'The primary palette is teal and sand; gradients are reserved for campaigns.'],
  ['Public holidays', 'Songkran and New Year closures are announced to merchants six weeks ahead.'],
  [
    'Expense claims',
    'Receipts are photographed in the expense app within thirty days of purchase.',
  ],
  [
    'Code review',
    'Reviewers approve small pull requests quickly and explain every requested change.',
  ],
  [
    'Password manager',
    'Shared credentials live in vaults owned by a team, never in chat messages.',
  ],
  [
    'Vendor due diligence',
    'Procurement collects security questionnaires before signing any vendor.',
  ],
  ['Data retention', 'Chat transcripts are deleted after two years unless legal hold applies.'],
  ['Accessibility', 'Screens pass contrast checks and every icon button carries a readable label.'],
  ['Hiring loop', 'Candidates meet four interviewers and receive feedback within five days.'],
  ['Release notes', 'Product marketing drafts release notes and translates them into Thai.'],
  [
    'Mobile crashes',
    'Crash reports are triaged daily and regressions block the next store release.',
  ],
  ['Feature flags', 'Flags older than ninety days are removed or promoted to configuration.'],
  ['Dispute evidence', 'Chargeback evidence packs include receipts, delivery proof and chat logs.'],
  ['Fraud rules', 'Velocity rules flag cards used in three countries within one hour.'],
  ['KYC documents', 'Merchants upload identity cards and company affidavits during onboarding.'],
  ['Tax invoices', 'Tax invoices show the VAT number and are emailed as signed PDF files.'],
];

function section([heading, sentence]: [string, string]): string {
  return `## ${heading}\n${Array.from({ length: 8 }, () => sentence).join(' ')}`;
}

/** The needle's section: other settlement paragraphs around it, so it isn't the only candidate. */
const SETTLEMENT_SECTION = [
  '## Settlement',
  "Settlement moves a merchant's balance from our clearing account to the merchant's own account. Finance reconciles the clearing account every morning against the acquirer report.",
  NEEDLE_PARAGRAPH,
  'Card settlements follow the acquirer calendar instead and are paid two business days after capture. Reconciliation differences above 500 THB are escalated to the finance lead.',
  'Merchants see each settlement in the dashboard with its reference number, so they can match it against their own statement.',
  'During Songkran and New Year the settlement calendar skips public holidays; finance publishes the adjusted dates in the merchant newsletter.',
  'A failed transfer is retried once automatically. After that, support contacts the merchant to confirm the account details before the next attempt.',
].join('\n\n');

/** About 38,000 characters: dozens of chunks, one of which holds the needle. */
export const HANDBOOK = [
  '# Payments operations handbook',
  ...TOPICS.slice(0, 11).map(section),
  SETTLEMENT_SECTION,
  ...TOPICS.slice(11).map(section),
  ...TOPICS.map(([heading, sentence]) => section([`${heading} (appendix)`, sentence])),
  ...TOPICS.map(([heading, sentence]) => section([`${heading} (2025 archive)`, sentence])),
].join('\n\n');

export type FixtureDocument = { title: string; text: string };

/** The Feature's other Attachments. */
export const FEATURE_ATTACHMENTS: FixtureDocument[] = [
  { title: 'Payments operations handbook', text: HANDBOOK },
  {
    title: 'Risk policy',
    text: `# Risk policy\n\n${TOPICS.slice(16).map(section).join('\n\n')}`,
  },
  {
    title: 'Vendor contract summary',
    text: '# Vendor contract\n\nThe acquirer contract runs for three years with a ninety-day notice period. Pricing is 1.6% per card transaction.',
  },
];

/** Other Features of the same Project, with their Specs. */
export const OTHER_FEATURES: { title: string; spec: string }[] = [
  {
    title: 'Card refunds',
    spec: '# Card refunds\n\n## Goal\nSupport agents refund card payments from the admin console.\n\n## Acceptance criteria\n- [ ] A partial refund keeps the rest of the charge captured.',
  },
  {
    title: 'Merchant onboarding',
    spec: '# Merchant onboarding\n\n## Goal\nMerchants go live after a compliance review of their documents.',
  },
];

/**
 * A document in another Project that matches the question even better. It must
 * never be retrieved for this Project.
 */
export const OTHER_PROJECT_DECOY: FixtureDocument = {
  title: 'Decoy: another Project',
  text: `# Decoy\n\nDECOY-OTHER-PROJECT. PromptPay settlement cutoff for the payout scheduler: the bank closes late batches at 18:00. ${NEEDLE_QUESTION.title} ${NEEDLE_QUESTION.description}`,
};
