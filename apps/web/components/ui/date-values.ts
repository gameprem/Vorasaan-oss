import {
  type CalendarDate,
  type CalendarDateTime,
  GregorianCalendar,
  parseDate,
  parseDateTime,
  parseTime,
  type Time,
  toCalendar,
} from '@internationalized/date';

// Our forms keep dates as the strings native inputs used: '2026-03-05' for a day,
// '2026-03-05T09:30' for a day and time, '09:30' for a time. The kit's pickers convert to
// and from React Aria's date objects here, always storing the Gregorian (ISO) date, whatever
// calendar the picker shows.

export type DateGranularity = 'day' | 'minute';

/** '2026-03-05' or '2026-03-05T09:30' → a date object, or null when empty or invalid. */
export function parseIsoDate(
  value: string | undefined,
  granularity: DateGranularity = 'day',
): CalendarDate | CalendarDateTime | null {
  if (!value) return null;
  try {
    return granularity === 'minute' ? parseDateTime(value) : parseDate(value.slice(0, 10));
  } catch {
    return null;
  }
}

/** A date object (in any calendar) → '2026-03-05' or '2026-03-05T09:30', in the ISO calendar. */
export function toIsoDate(date: CalendarDate | CalendarDateTime | null | undefined): string {
  if (!date) return '';
  const iso = toCalendar(date, new GregorianCalendar()).toString();
  return 'hour' in date ? iso.slice(0, 16) : iso.slice(0, 10);
}

/** '09:30' → a Time, or null. */
export function parseIsoTime(value: string | undefined): Time | null {
  if (!value) return null;
  try {
    return parseTime(value);
  } catch {
    return null;
  }
}

/** A Time → '09:30'. */
export const toIsoTime = (time: Time | null | undefined) =>
  time ? time.toString().slice(0, 5) : '';

/**
 * The locale to show dates in: `locale` with the Buddhist calendar when `buddhistEra` is
 * true, the Gregorian one when false, and the locale's own (Buddhist for Thai) when unset.
 */
export function calendarLocale(locale: string, buddhistEra?: boolean): string {
  if (buddhistEra === undefined) return locale;
  const base = locale.split('-u-')[0] ?? locale;
  return `${base}-u-ca-${buddhistEra ? 'buddhist' : 'gregory'}`;
}
