import { describe, expect, test } from 'bun:test';
import { HOUR, MINUTE, type WorkingCalendar } from '../response-windows/working-time.ts';
import {
  heldSpans,
  leadTime,
  needsInfoPauses,
  percentile,
  type RequestTimeline,
  timeWaited,
} from './lead-time.ts';

/** UTC, Monday to Friday 09:00-18:00. */
const CAL: WorkingCalendar = {
  timeZone: 'UTC',
  workingDays: new Set([1, 2, 3, 4, 5]),
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  holidays: new Set(),
};
// 2026-10-05 is a Monday.
const at = (local: string) => new Date(`2026-10-${local}:00Z`);

function timeline(over: Partial<RequestTimeline> = {}): RequestTimeline {
  return {
    id: 'r',
    sentAt: at('05T10:00'),
    endedAt: null,
    decided: false,
    pauses: [],
    recipients: [{ userId: 'pim', from: at('05T10:00') }],
    deciderChanges: [],
    ...over,
  };
}

describe('Decision Lead Time', () => {
  test('counts Working Time from sent to decided', () => {
    // Monday 10:00 to Tuesday 11:00: 8h on Monday, 2h on Tuesday.
    const t = timeline({ endedAt: at('06T11:00'), decided: true });
    expect(leadTime(t, CAL)).toBe(10 * HOUR);
  });

  test('is null until decided, and for a withdrawn request', () => {
    expect(leadTime(timeline(), CAL)).toBeNull();
    expect(leadTime(timeline({ endedAt: at('05T12:00') }), CAL)).toBeNull();
  });

  test('leaves out the time spent waiting for the Raiser in NEEDS_INFO', () => {
    const pauses = needsInfoPauses([
      { kind: 'QUESTION', createdAt: at('05T11:00') },
      { kind: 'NOTE', createdAt: at('05T12:00') },
      { kind: 'ANSWER', createdAt: at('05T14:00') },
    ]);
    expect(pauses).toEqual([{ from: at('05T11:00'), to: at('05T14:00') }]);
    const t = timeline({ endedAt: at('05T15:00'), decided: true, pauses });
    // 10-11 and 14-15.
    expect(leadTime(t, CAL)).toBe(2 * HOUR);
  });

  test('a question still unanswered pauses until the end', () => {
    const pauses = needsInfoPauses([{ kind: 'QUESTION', createdAt: at('05T11:00') }]);
    expect(pauses).toEqual([{ from: at('05T11:00'), to: null }]);
    expect(heldSpans(timeline({ pauses }), at('05T17:00'))).toEqual([
      { from: at('05T10:00'), to: at('05T11:00'), holders: ['pim'] },
    ]);
  });

  test('the wait is held by the routed Recipients until a Claim, then by the Decider', () => {
    const t = timeline({
      recipients: [
        { userId: 'pim', from: at('05T10:00') },
        { userId: 'mint', from: at('05T10:00') },
        // A Delegate added by escalation step 2.
        { userId: 'fern', from: at('05T13:00') },
      ],
      deciderChanges: [
        { userId: 'mint', at: at('05T14:00') },
        { userId: 'oak', at: at('05T16:00') },
      ],
      endedAt: at('05T17:00'),
      decided: true,
    });
    expect(heldSpans(t, at('05T18:00'))).toEqual([
      { from: at('05T10:00'), to: at('05T13:00'), holders: ['pim', 'mint'] },
      { from: at('05T13:00'), to: at('05T14:00'), holders: ['pim', 'mint', 'fern'] },
      { from: at('05T14:00'), to: at('05T16:00'), holders: ['mint'] },
      { from: at('05T16:00'), to: at('05T17:00'), holders: ['oak'] },
    ]);

    const { byPerson, byRole } = timeWaited(
      [{ ...t, role: 'PO' }],
      { from: at('05T00:00'), to: at('06T00:00') },
      at('05T18:00'),
      CAL,
    );
    expect(Object.fromEntries(byPerson)).toEqual({
      pim: { minutes: 240, requests: 1 },
      mint: { minutes: 360, requests: 1 },
      fern: { minutes: 60, requests: 1 },
      oak: { minutes: 60, requests: 1 },
    });
    expect(Object.fromEntries(byRole)).toEqual({ PO: { minutes: 420, requests: 1 } });
  });

  test('time waited is clipped to the range and to now, outside working hours', () => {
    const t = { ...timeline(), role: 'PO' };
    // Open since Monday 10:00; asked about Monday 12:00-20:00, now Tuesday 10:00.
    const { byPerson } = timeWaited(
      [t],
      { from: at('05T12:00'), to: at('05T20:00') },
      at('06T10:00'),
      CAL,
    );
    expect(byPerson.get('pim')).toEqual({ minutes: (6 * HOUR) / MINUTE, requests: 1 });
  });

  test('percentiles interpolate between the closest ranks', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([60], 0.9)).toBe(60);
    expect(percentile([240, 60, 120], 0.5)).toBe(120);
    expect(percentile([60, 120, 180, 240], 0.5)).toBe(150);
    expect(percentile([60, 120, 240], 0.9)).toBeCloseTo(216);
  });
});
