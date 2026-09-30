import type { DecisionRequestStatus } from '@vorasaan/shared';

// The single source of truth for Decision Request lifecycle rules.
//   DRAFT → OPEN ⇄ NEEDS_INFO → DECIDED → SPEC_UPDATED, and WITHDRAWN before a Decision.

export type DecisionRequestEvent =
  | 'submit'
  | 'withdraw'
  | 'askForInfo'
  | 'provideInfo'
  | 'decide'
  | 'approveSpecProposal';

const TRANSITIONS: Record<
  DecisionRequestStatus,
  Partial<Record<DecisionRequestEvent, DecisionRequestStatus>>
> = {
  DRAFT: { submit: 'OPEN', withdraw: 'WITHDRAWN' },
  OPEN: { decide: 'DECIDED', askForInfo: 'NEEDS_INFO', withdraw: 'WITHDRAWN' },
  NEEDS_INFO: { provideInfo: 'OPEN', withdraw: 'WITHDRAWN' },
  DECIDED: { approveSpecProposal: 'SPEC_UPDATED' },
  SPEC_UPDATED: {},
  WITHDRAWN: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DecisionRequestStatus,
    readonly event: DecisionRequestEvent,
  ) {
    super(`Cannot ${event} a Decision Request that is ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export function nextStatus(
  from: DecisionRequestStatus,
  event: DecisionRequestEvent,
): DecisionRequestStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: DecisionRequestStatus, event: DecisionRequestEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}
