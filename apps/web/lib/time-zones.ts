import { TimeZone } from '@vorasaan/shared';

/** Every IANA time zone the browser knows, with `current` first if it isn't among them. */
export function timeZones(current: string): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

/**
 * The browser's time zone, such as Asia/Bangkok (ticket 0063), or UTC when the browser
 * doesn't say or says something that isn't an IANA zone. `intl` is for tests.
 */
export function browserTimeZone(intl: Pick<typeof Intl, 'DateTimeFormat'> = Intl): string {
  try {
    const zone = intl.DateTimeFormat().resolvedOptions().timeZone;
    return TimeZone.safeParse(zone).success ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}
