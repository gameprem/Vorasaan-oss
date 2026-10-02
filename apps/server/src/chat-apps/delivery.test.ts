import { describe, expect, test } from 'bun:test';
import { type ChatDeliveryPreferences, chatDelivery, inQuietHours } from './delivery.ts';

const prefs = (over: Partial<ChatDeliveryPreferences> = {}): ChatDeliveryPreferences => ({
  events: ['DECISION_REQUEST', 'NEEDS_INFO'],
  quietStartMinute: null,
  quietEndMinute: null,
  timeZone: 'Asia/Bangkok',
  ...over,
});

// Bangkok is UTC+7 all year.
const bangkok = (time: string) => new Date(`2026-10-02T${time}:00+07:00`);

describe('chat delivery preferences', () => {
  test('only the chosen events go to chat apps', () => {
    expect(chatDelivery(prefs(), 'DECISION_REQUEST', bangkok('10:00'))).toBe('send');
    expect(chatDelivery(prefs(), 'NEEDS_INFO', bangkok('10:00'))).toBe('send');
    expect(chatDelivery(prefs(), 'SPEC_PROPOSAL', bangkok('10:00'))).toBe('not-chosen');
    expect(chatDelivery(prefs({ events: [] }), 'DECISION_REQUEST', bangkok('10:00'))).toBe(
      'not-chosen',
    );
  });

  test('quiet hours across midnight, in the person’s time zone', () => {
    const night = prefs({ quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 });
    expect(inQuietHours(night, bangkok('21:59'))).toBe(false);
    expect(inQuietHours(night, bangkok('22:00'))).toBe(true);
    expect(inQuietHours(night, bangkok('03:30'))).toBe(true);
    expect(inQuietHours(night, bangkok('06:59'))).toBe(true);
    expect(inQuietHours(night, bangkok('07:00'))).toBe(false);
    expect(chatDelivery(night, 'DECISION_REQUEST', bangkok('23:00'))).toBe('quiet-hours');
    // 23:00 in Bangkok is 16:00 UTC: not quiet for someone counting in UTC.
    expect(inQuietHours({ ...night, timeZone: 'UTC' }, bangkok('23:00'))).toBe(false);
  });

  test('quiet hours within one day', () => {
    const lunch = prefs({ quietStartMinute: 12 * 60, quietEndMinute: 13 * 60 });
    expect(inQuietHours(lunch, bangkok('11:59'))).toBe(false);
    expect(inQuietHours(lunch, bangkok('12:30'))).toBe(true);
    expect(inQuietHours(lunch, bangkok('13:00'))).toBe(false);
  });

  test('no quiet hours', () => {
    expect(inQuietHours(prefs(), bangkok('03:00'))).toBe(false);
  });
});
