import type { DecisionRequestKind, DecisionRequestStatus } from '@vorasaan/shared';

/**
 * A Feature is Blocked while any Blocker on it is OPEN or NEEDS_INFO. Open
 * Questions don't count. Use as `_count: { select: { decisionRequests: OPEN_BLOCKERS } }`.
 */
export const OPEN_BLOCKERS = {
  where: {
    kind: 'BLOCKER' as DecisionRequestKind,
    status: { in: ['OPEN', 'NEEDS_INFO'] as DecisionRequestStatus[] },
  },
};
