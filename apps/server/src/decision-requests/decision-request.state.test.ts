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

  test('askForInfo only from OPEN, provideInfo only from NEEDS_INFO', () => {
    for (const from of DecisionRequestStatus.options) {
      expect(canTransition(from, 'askForInfo')).toBe(from === 'OPEN');
      expect(canTransition(from, 'provideInfo')).toBe(from === 'NEEDS_INFO');
    }
  });

  test('a Decision cannot be made while waiting for more info', () => {
    expect(canTransition('NEEDS_INFO', 'decide')).toBe(false);
    expect(() => nextStatus('NEEDS_INFO', 'decide')).toThrow(
      'Cannot decide a Decision Request that is NEEDS_INFO',
    );
  });

  test('a note keeps the status, and only while OPEN or NEEDS_INFO', () => {
    expect(nextStatus('OPEN', 'addNote')).toBe('OPEN');
    expect(nextStatus('NEEDS_INFO', 'addNote')).toBe('NEEDS_INFO');
    for (const from of ['DRAFT', 'DECIDED', 'SPEC_UPDATED', 'WITHDRAWN'] as const) {
      expect(canTransition(from, 'addNote')).toBe(false);
    }
  });

  test('Claim and reassign keep the request OPEN, and only from OPEN', () => {
    expect(nextStatus('OPEN', 'claim')).toBe('OPEN');
    expect(nextStatus('OPEN', 'reassign')).toBe('OPEN');
    for (const from of DecisionRequestStatus.options.filter((s) => s !== 'OPEN')) {
      expect(canTransition(from, 'claim')).toBe(false);
      expect(canTransition(from, 'reassign')).toBe(false);
    }
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
      'claim',
      'reassign',
      'withdraw',
      'askForInfo',
      'provideInfo',
      'addNote',
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
