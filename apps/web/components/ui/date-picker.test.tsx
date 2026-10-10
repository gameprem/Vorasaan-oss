import { describe, expect, test } from 'bun:test';
import { I18nProvider } from 'react-aria-components';
import { renderToStaticMarkup } from 'react-dom/server';
import { DatePicker } from './date-picker';
import { calendarLocale, parseIsoDate, toIsoDate } from './date-values';

// Ticket 0077: the date picker can show a Buddhist-era year (2569 for 2026), and stores the
// same ISO date whichever calendar it shows.

/** The picker's segments as text, and the value its hidden input submits. */
function render(locale: string, props: Parameters<typeof DatePicker>[0]) {
  const html = renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <DatePicker name="day" {...props} />
    </I18nProvider>,
  );
  const segments = [...html.matchAll(/role="spinbutton"[^>]*>([^<]*)</g)].map((m) => m[1]);
  const submitted = html.match(/type="hidden" name="day" value="([^"]*)"/)?.[1];
  return { segments, submitted };
}

describe('DatePicker', () => {
  test('shows a Buddhist-era year when asked, and submits the ISO date', () => {
    const shown = render('en-GB', { label: 'Holiday', value: '2026-03-05', buddhistEra: true });
    expect(shown.segments).toContain('2569');
    expect(shown.segments).not.toContain('2026');
    expect(shown.submitted).toBe('2026-03-05');
  });

  test('shows the Gregorian year when not asked, with the same ISO date', () => {
    const shown = render('en-GB', { label: 'Holiday', value: '2026-03-05' });
    expect(shown.segments).toContain('2026');
    expect(shown.submitted).toBe('2026-03-05');
  });

  test('follows the language: Thai shows the Buddhist era unless told otherwise', () => {
    expect(render('th-TH', { label: 'วันหยุด', value: '2026-03-05' }).segments).toContain('2569');
    expect(
      render('th-TH', { label: 'วันหยุด', value: '2026-03-05', buddhistEra: false }).segments,
    ).toContain('2026');
  });

  test('a day and time keeps the datetime-local format', () => {
    const shown = render('en-GB', {
      label: 'Starts',
      value: '2026-10-03T09:30',
      granularity: 'minute',
      buddhistEra: true,
    });
    expect(shown.segments).toEqual(expect.arrayContaining(['2569', '09', '30']));
    expect(shown.submitted).toBe('2026-10-03T09:30');
  });
});

describe('date values', () => {
  test('round-trip through the Buddhist calendar unchanged', () => {
    const date = parseIsoDate('2026-03-05');
    expect(toIsoDate(date)).toBe('2026-03-05');
    expect(toIsoDate(parseIsoDate('2026-03-05T23:45', 'minute'))).toBe('2026-03-05T23:45');
    expect(toIsoDate(parseIsoDate('not a date'))).toBe('');
  });

  test('the calendar locale', () => {
    expect(calendarLocale('th-TH')).toBe('th-TH');
    expect(calendarLocale('en-GB', true)).toBe('en-GB-u-ca-buddhist');
    expect(calendarLocale('th-TH-u-ca-buddhist', false)).toBe('th-TH-u-ca-gregory');
  });
});
