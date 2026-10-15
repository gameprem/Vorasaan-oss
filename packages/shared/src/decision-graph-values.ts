import type { DecisionGraphBranchState } from './decision-graph.ts';

// Plain values of decision-graph.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** The states of a branch not yet merged or closed: drawn dashed. */
export const OPEN_BRANCH_STATES: readonly DecisionGraphBranchState[] = [
  'WAITING',
  'NEEDS_INFO',
  'AWAITING_APPROVAL',
];
