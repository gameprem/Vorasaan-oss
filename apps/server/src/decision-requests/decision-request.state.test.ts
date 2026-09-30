import { describe, expect, test } from 'bun:test';
import { DecisionRequestStatus } from '@vorasaan/shared';
import {
  canTransition,
  type DecisionRequestEvent,
  InvalidTransitionError,
  nextStatus,
} from './decision-request.state.ts';

describe('Decision Request state machine', () => {
  test('happy path: DRAFT → OPEN → DECIDED → SPEC_UPDATED', () => {
    expect(nextStatus('DRAFT', 'submit')).toBe('OPEN');
    expect(nextStatus('OPEN', 'decide')).toBe('DECIDED');
    expect(nextStatus('DECIDED', 'approveSpecProposal')).toBe('SPEC_UPDATED');
  });

  test('NEEDS_INFO loops back to OPEN', () => {
    expect(nextStatus('OPEN', 'askForInfo')).toBe('NEEDS_INFO');
    expect(nextStatus('NEEDS_INFO', 'provideInfo')).toBe('OPEN');
  });

  test('withdraw is allowed only before a Decision', () => {
    for (const from of ['DRAFT', 'OPEN', 'NEEDS_INFO'] as const) {
      expect(nextStatus(from, 'withdraw')).toBe('WITHDRAWN');
    }
    for (const from of ['DECIDED', 'SPEC_UPDATED', 'WITHDRAWN'] as const) {
      expect(canTransition(from, 'withdraw')).toBe(false);
    }
  });

  test('terminal states accept no events', () => {
    const events: DecisionRequestEvent[] = [
      'submit',
      'withdraw',
      'askForInfo',
      'provideInfo',
      'decide',
      'approveSpecProposal',
    ];
    for (const from of ['SPEC_UPDATED', 'WITHDRAWN'] as const) {
      for (const event of events) expect(canTransition(from, event)).toBe(false);
    }
  });

  test('invalid transitions throw a typed error', () => {
    expect(() => nextStatus('DRAFT', 'decide')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('OPEN', 'submit')).toThrow(
      'Cannot submit a Decision Request that is OPEN',
    );
  });

  test('every status is covered', () => {
    for (const status of DecisionRequestStatus.options) {
      expect(() => canTransition(status, 'submit')).not.toThrow();
    }
  });
});
