import type { ResponseWindow } from '@vorasaan/shared';

// Working time in an Organization's calendar (ADR 0011): its time zone, working days,
// working hours and holidays. Pure; time zones come from Intl, so daylight saving
// time follows the IANA database Bun ships with. Lengths are in milliseconds.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export type WorkingCalendar = {
  /** IANA time zone, such as Asia/Bangkok. */
  timeZone: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  workingDays: ReadonlySet<number>;
  /** Working hours, in minutes after local midnight; end > start. */
  startMinute: number;
  endMinute: number;
  /** Local dates (YYYY-MM-DD) with no working time. */
  holidays: ReadonlySet<string>;
};

/** Give up after this many days without finding enough working time (a broken calendar). */
const MAX_DAYS = 3 * 366;

type LocalDate = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time at instant `t` in `timeZone`, as if it were UTC. */
function wallClock(t: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** How far `timeZone` is ahead of UTC at instant `t`. */
const offsetAt = (t: number, timeZone: string) =>
  wallClock(t, timeZone) - Math.floor(t / 1000) * 1000;

/** The instant of `minute` after local midnight of `date` (a skipped DST time moves forward). */
function instantOf(date: LocalDate, minute: number, timeZone: string): number {
  const wall = Date.UTC(date.y, date.m - 1, date.d, 0, minute);
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

function localDateOf(t: number, timeZone: string): LocalDate {
  const wall = new Date(wallClock(t, timeZone));
  return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate() };
}

function nextDay({ y, m, d }: LocalDate): LocalDate {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

const isoDate = ({ y, m, d }: LocalDate) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function isWorkingDay(date: LocalDate, cal: WorkingCalendar): boolean {
  const weekday = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() || 7;
  return cal.workingDays.has(weekday) && !cal.holidays.has(isoDate(date));
}

/**
 * Each calendar's working hours by local date, kept as long as the calendar object
 * itself (one request, one job run): Decision Lead Time walks the same days for every
 * request of a Project, and each day costs a few time zone conversions (ticket 0074).
 */
const hoursByCalendar = new WeakMap<WorkingCalendar, Map<string, [number, number] | null>>();

/** The working hours of `date` as instants, or null on a day off. */
function workingHours(date: LocalDate, cal: WorkingCalendar): [number, number] | null {
  let days = hoursByCalendar.get(cal);
  if (!days) {
    days = new Map();
    hoursByCalendar.set(cal, days);
  }
  const key = isoDate(date);
  let hours = days.get(key);
  if (hours === undefined) {
    hours = isWorkingDay(date, cal)
      ? [
          instantOf(date, cal.startMinute, cal.timeZone),
          instantOf(date, cal.endMinute, cal.timeZone),
        ]
      : null;
    days.set(key, hours);
  }
  return hours;
}

/**
 * The earliest instant after `start` with `length` of working time in between. A
 * window that ends exactly at closing time ends then, not at the next opening.
 */
export function addWorkingTime(start: Date, length: number, cal: WorkingCalendar): Date {
  const from = start.getTime();
  let left = length;
  if (left <= 0) return new Date(from);
  let day = localDateOf(from, cal.timeZone);
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    const hours = workingHours(day, cal);
    if (!hours) continue;
    const open = Math.max(hours[0], from);
    if (open >= hours[1]) continue;
    const available = hours[1] - open;
    if (left <= available) return new Date(open + left);
    left -= available;
  }
  throw new Error('The working calendar has no working time in the next three years');
}

/** How much working time lies between `from` and `to` (0 when `to` is not later). */
export function workingTimeBetween(from: Date, to: Date, cal: WorkingCalendar): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  const last = isoDate(localDateOf(b, cal.timeZone));
  let total = 0;
  let day = localDateOf(a, cal.timeZone);
  for (let i = 0; i < MAX_DAYS && isoDate(day) <= last; i++, day = nextDay(day)) {
    const hours = workingHours(day, cal);
    if (!hours) continue;
    const start = Math.max(hours[0], a);
    const end = Math.min(hours[1], b);
    if (end > start) total += end - start;
  }
  return total;
}

/** A window's length in working time: a working day is one day of working hours. */
export function windowLength(window: ResponseWindow, cal: WorkingCalendar): number {
  return window.unit === 'WORKING_HOURS'
    ? window.value * HOUR
    : window.value * (cal.endMinute - cal.startMinute) * MINUTE;
}
