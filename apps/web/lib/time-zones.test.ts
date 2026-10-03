import { describe, expect, test } from 'bun:test';
import { browserTimeZone } from './time-zones';

/** An `Intl` whose DateTimeFormat reports `timeZone`, or throws. */
const mockedIntl = (timeZone: string | undefined | Error) =>
  ({
    DateTimeFormat: () => ({
      resolvedOptions: () => {
        if (timeZone instanceof Error) throw timeZone;
        return { timeZone };
      },
    }),
  }) as unknown as Pick<typeof Intl, 'DateTimeFormat'>;

describe('browserTimeZone (the setup wizard prefill, ticket 0063)', () => {
  test('is the browser’s IANA time zone', () => {
    expect(browserTimeZone(mockedIntl('Asia/Bangkok'))).toBe('Asia/Bangkok');
    expect(browserTimeZone(mockedIntl('America/New_York'))).toBe('America/New_York');
  });

  test('falls back to UTC when the browser says nothing usable', () => {
    expect(browserTimeZone(mockedIntl(undefined))).toBe('UTC');
    expect(browserTimeZone(mockedIntl('Mars/Olympus'))).toBe('UTC');
    expect(browserTimeZone(mockedIntl(new Error('no Intl')))).toBe('UTC');
  });
});
