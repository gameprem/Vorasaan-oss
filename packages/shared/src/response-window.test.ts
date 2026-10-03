import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RESPONSE_WINDOW_SETTINGS,
  ProjectResponseWindowsInput,
  ResponseWindowSettingsInput,
  responseWindowLabels,
  WorkingTimeInput,
} from './response-window.ts';

const now = new Date('2026-10-05T10:00:00Z');
const at = (iso: string) => new Date(iso).toISOString();

describe('responseWindowLabels', () => {
  test('due in, rounded down to minutes, hours or days', () => {
    const due = (dueAt: string) =>
      responseWindowLabels({ dueAt: at(dueAt), paused: false, escalationStep: 0 }, now);
    expect(due('2026-10-05T12:00:00Z')).toEqual(['due in 2h']);
    expect(due('2026-10-05T12:59:00Z')).toEqual(['due in 2h']);
    expect(due('2026-10-05T10:45:00Z')).toEqual(['due in 45m']);
    expect(due('2026-10-05T10:00:30Z')).toEqual(['due in 1m']);
    expect(due('2026-10-07T10:00:00Z')).toEqual(['due in 2d']);
  });

  test('overdue once the window has run out, and "escalated" from the Delegate step on', () => {
    const label = (dueAt: string, escalationStep: number) =>
      responseWindowLabels({ dueAt: at(dueAt), paused: false, escalationStep }, now);
    expect(label('2026-10-05T09:00:00Z', 1)).toEqual(['overdue 1h']);
    expect(label('2026-10-05T10:00:00Z', 0)).toEqual(['overdue 1m']);
    expect(label('2026-10-05T07:00:00Z', 2)).toEqual(['overdue 3h', 'escalated']);
    expect(label('2026-10-02T10:00:00Z', 3)).toEqual(['overdue 3d', 'escalated']);
  });

  test('nothing while paused for NEEDS_INFO or without a window', () => {
    expect(
      responseWindowLabels(
        { dueAt: at('2026-10-05T09:00:00Z'), paused: true, escalationStep: 1 },
        now,
      ),
    ).toEqual([]);
    expect(responseWindowLabels({ dueAt: null, paused: false, escalationStep: 0 }, now)).toEqual(
      [],
    );
  });
});

describe('ResponseWindowSettingsInput', () => {
  const valid = {
    ...DEFAULT_RESPONSE_WINDOW_SETTINGS,
    timeZone: 'Asia/Bangkok',
    holidays: [{ date: '2026-10-13', name: 'King Bhumibol Memorial Day' }],
  };

  test('the defaults are valid: Blocker 4 working hours, Question 2 working days', () => {
    expect(ResponseWindowSettingsInput.parse(DEFAULT_RESPONSE_WINDOW_SETTINGS)).toMatchObject({
      blocker: { value: 4, unit: 'WORKING_HOURS' },
      question: { value: 2, unit: 'WORKING_DAYS' },
      workingDays: [1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
    });
    expect(ResponseWindowSettingsInput.safeParse(valid).success).toBe(true);
  });

  test('refuses an unknown time zone, no working day, an empty day and duplicate holidays', () => {
    const bad = (patch: object) => ResponseWindowSettingsInput.safeParse({ ...valid, ...patch });
    expect(bad({ timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(bad({ workingDays: [] }).success).toBe(false);
    expect(bad({ workingDays: [1, 1] }).success).toBe(false);
    expect(bad({ workingDays: [8] }).success).toBe(false);
    expect(bad({ workStart: '18:00', workEnd: '09:00' }).success).toBe(false);
    expect(bad({ workStart: '9am' }).success).toBe(false);
    expect(
      bad({
        holidays: [
          { date: '2026-10-13', name: 'A' },
          { date: '2026-10-13', name: 'B' },
        ],
      }).success,
    ).toBe(false);
    expect(bad({ holidays: [{ date: '2026-02-30', name: 'A' }] }).success).toBe(false);
    expect(bad({ blocker: { value: 0, unit: 'WORKING_HOURS' } }).success).toBe(false);
  });
});

test('ProjectResponseWindowsInput: null keeps the Organization default', () => {
  expect(
    ProjectResponseWindowsInput.parse({
      blocker: { value: 2, unit: 'WORKING_HOURS' },
      question: null,
    }),
  ).toEqual({ blocker: { value: 2, unit: 'WORKING_HOURS' }, question: null });
});

test('WorkingTimeInput (first-run setup): the same checks, without holidays or windows', () => {
  const valid = {
    timeZone: 'Asia/Bangkok',
    workingDays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
  };
  expect(WorkingTimeInput.safeParse(valid).success).toBe(true);
  const { timeZone: _, ...noTimeZone } = valid;
  expect(WorkingTimeInput.safeParse(noTimeZone).success).toBe(false);
  expect(WorkingTimeInput.safeParse({ ...valid, timeZone: 'Mars/Olympus' }).success).toBe(false);
  expect(WorkingTimeInput.safeParse({ ...valid, workEnd: '08:00' }).success).toBe(false);
  expect(WorkingTimeInput.safeParse({ ...valid, holidays: [] }).success).toBe(false);
});
