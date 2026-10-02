import { describe, expect, test } from 'bun:test';
import {
  addWorkingTime,
  HOUR,
  MINUTE,
  type WorkingCalendar,
  windowLength,
  workingTimeBetween,
} from './working-time.ts';

// Asia/Bangkok is UTC+7 all year; America/New_York has DST (2026: from 8 March, until 1 November).
const bangkok = (holidays: string[] = []): WorkingCalendar => ({
  timeZone: 'Asia/Bangkok',
  workingDays: new Set([1, 2, 3, 4, 5]),
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  holidays: new Set(holidays),
});
/** A Bangkok wall-clock time as an instant. */
const bkk = (local: string) => new Date(`${local}+07:00`);

describe('addWorkingTime', () => {
  test('a Blocker sent Friday 16:00 with 09-18 Monday to Friday is due Monday 11:00', () => {
    // 2026-10-02 is a Friday.
    expect(addWorkingTime(bkk('2026-10-02T16:00'), 4 * HOUR, bangkok())).toEqual(
      bkk('2026-10-05T11:00'),
    );
  });

  test('a holiday on that Monday moves it to Tuesday 11:00', () => {
    expect(addWorkingTime(bkk('2026-10-02T16:00'), 4 * HOUR, bangkok(['2026-10-05']))).toEqual(
      bkk('2026-10-06T11:00'),
    );
  });

  test('starting before, after or outside working hours counts from the next opening', () => {
    const cal = bangkok();
    expect(addWorkingTime(bkk('2026-10-05T07:00'), HOUR, cal)).toEqual(bkk('2026-10-05T10:00'));
    expect(addWorkingTime(bkk('2026-10-05T20:00'), HOUR, cal)).toEqual(bkk('2026-10-06T10:00'));
    expect(addWorkingTime(bkk('2026-10-03T12:00'), HOUR, cal)).toEqual(bkk('2026-10-05T10:00'));
  });

  test('a window that exactly fills the day ends at closing time, not the next morning', () => {
    expect(addWorkingTime(bkk('2026-10-05T14:00'), 4 * HOUR, bangkok())).toEqual(
      bkk('2026-10-05T18:00'),
    );
  });

  test('2 working days from Tuesday 10:00 is Thursday 10:00', () => {
    const cal = bangkok();
    expect(
      addWorkingTime(
        bkk('2026-10-06T10:00'),
        windowLength({ value: 2, unit: 'WORKING_DAYS' }, cal),
        cal,
      ),
    ).toEqual(bkk('2026-10-08T10:00'));
  });

  test('working days other than Monday to Friday (Sunday to Thursday)', () => {
    const cal = { ...bangkok(), workingDays: new Set([7, 1, 2, 3, 4]) };
    // Thursday 2026-10-08 16:00 + 4h: 2h Thursday, Friday and Saturday off, 2h Sunday.
    expect(addWorkingTime(bkk('2026-10-08T16:00'), 4 * HOUR, cal)).toEqual(bkk('2026-10-11T11:00'));
  });

  test('follows daylight saving time in the Organization time zone', () => {
    const ny: WorkingCalendar = { ...bangkok(), timeZone: 'America/New_York' };
    // Friday 2026-03-06 16:00 EST (21:00Z) + 4h: Monday 2026-03-09 11:00 EDT (15:00Z).
    expect(addWorkingTime(new Date('2026-03-06T21:00:00Z'), 4 * HOUR, ny)).toEqual(
      new Date('2026-03-09T15:00:00Z'),
    );
  });

  test('zero adds nothing', () => {
    const start = bkk('2026-10-04T03:00');
    expect(addWorkingTime(start, 0, bangkok())).toEqual(start);
  });
});

describe('workingTimeBetween', () => {
  test('counts only working hours, across a weekend and a holiday', () => {
    expect(workingTimeBetween(bkk('2026-10-02T17:00'), bkk('2026-10-05T10:00'), bangkok())).toBe(
      2 * HOUR,
    );
    expect(
      workingTimeBetween(bkk('2026-10-02T17:00'), bkk('2026-10-06T10:00'), bangkok(['2026-10-05'])),
    ).toBe(2 * HOUR);
    expect(workingTimeBetween(bkk('2026-10-05T10:15'), bkk('2026-10-05T10:45'), bangkok())).toBe(
      30 * MINUTE,
    );
  });

  test('nothing outside working hours, and nothing backwards', () => {
    expect(workingTimeBetween(bkk('2026-10-03T09:00'), bkk('2026-10-04T23:00'), bangkok())).toBe(0);
    expect(workingTimeBetween(bkk('2026-10-05T12:00'), bkk('2026-10-05T10:00'), bangkok())).toBe(0);
  });

  test('is the inverse of addWorkingTime', () => {
    const cal = bangkok(['2026-10-13']);
    for (const start of ['2026-10-02T16:00', '2026-10-03T08:00', '2026-10-12T17:59']) {
      for (const length of [MINUTE, 4 * HOUR, 9 * HOUR, 30 * HOUR]) {
        const from = bkk(start);
        expect(workingTimeBetween(from, addWorkingTime(from, length, cal), cal)).toBe(length);
      }
    }
  });
});

test('windowLength: hours are hours, a working day is one day of working hours', () => {
  const cal = bangkok();
  expect(windowLength({ value: 4, unit: 'WORKING_HOURS' }, cal)).toBe(4 * HOUR);
  expect(windowLength({ value: 2, unit: 'WORKING_DAYS' }, cal)).toBe(18 * HOUR);
});
