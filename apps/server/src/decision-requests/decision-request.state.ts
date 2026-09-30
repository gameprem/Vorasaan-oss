import type { DecisionRequestStatus } from '@vorasaan/shared';

// The single source of truth for Decision Request lifecycle rules.
//   DRAFT → OPEN ⇄ NEEDS_INFO → DECIDED → SPEC_UPDATED, and WITHDRAWN before a Decision.
// Claim and reassign change who the Decider is, not the status, and only while OPEN.
// A note adds to the thread without changing the status, while OPEN or NEEDS_INFO.

export type DecisionRequestEvent =
  | 'submit'
  | 'claim'
  | 'reassign'
  | 'withdraw'
  | 'askForInfo'
  | 'provideInfo'
  | 'addNote'
  | 'decide'
  | 'approveSpecProposal';

const TRANSITIONS: Record<
  DecisionRequestStatus,
  Partial<Record<DecisionRequestEvent, DecisionRequestStatus>>
> = {
  DRAFT: { submit: 'OPEN', withdraw: 'WITHDRAWN' },
  OPEN: {
    claim: 'OPEN',
    reassign: 'OPEN',
    decide: 'DECIDED',
    askForInfo: 'NEEDS_INFO',
    addNote: 'OPEN',
    withdraw: 'WITHDRAWN',
  },
  NEEDS_INFO: { provideInfo: 'OPEN', addNote: 'NEEDS_INFO', withdraw: 'WITHDRAWN' },
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
