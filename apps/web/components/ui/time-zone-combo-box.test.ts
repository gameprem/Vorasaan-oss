import { describe, expect, test } from 'bun:test';
import { searchTimeZones, timeZoneOffset, timeZoneOptions } from '@/lib/time-zones';
import { timeZonePickerOptions } from './time-zone-combo-box';

// Ticket 0077: the time-zone picker finds a zone by its city or zone, in English or Thai.

const zones = timeZoneOptions('Asia/Bangkok', new Date('2026-01-15T00:00:00Z'));
const ids = (query: string) => searchTimeZones(zones, query).map((z) => z.id);

describe('the time-zone combobox search', () => {
  test('finds Asia/Bangkok from "Bangkok" and from "กรุงเทพ"', () => {
    expect(ids('Bangkok')).toContain('Asia/Bangkok');
    expect(ids('bangkok')).toContain('Asia/Bangkok');
    expect(ids('กรุงเทพ')).toEqual(['Asia/Bangkok']);
  });

  test('finds a zone by its id, a city with a space, or its offset', () => {
    expect(ids('asia/tokyo')).toEqual(['Asia/Tokyo']);
    expect(ids('ho chi minh')).toContain('Asia/Ho_Chi_Minh');
    expect(ids('UTC+07:00')).toContain('Asia/Bangkok');
    expect(ids('nowhere-at-all')).toEqual([]);
  });

  test('each option shows the current offset and the Thai name', () => {
    const bangkok = timeZonePickerOptions(zones).find((o) => o.id === 'Asia/Bangkok');
    expect(bangkok?.label).toBe('Asia/Bangkok');
    expect(bangkok?.description).toBe('UTC+07:00 · กรุงเทพ');
    expect(timeZoneOffset('UTC')).toBe('UTC+00:00');
    expect(timeZoneOffset('America/New_York', new Date('2026-01-15T00:00:00Z'))).toBe('UTC-05:00');
  });
});
