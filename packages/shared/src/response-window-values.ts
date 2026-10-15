import type {
  ResponseWindow,
  ResponseWindowSettingsInput,
  ResponseWindowState,
} from './response-window.ts';

// Plain values of response-window.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** Whether the runtime knows `tz` as a time zone, such as Asia/Bangkok (`TimeZone`). */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** From this step on a request counts as "escalated": its Delegates were added. */
export const ESCALATED_FROM_STEP = 2;

/** What an Organization uses until an Admin saves its own. */
export const DEFAULT_RESPONSE_WINDOW_SETTINGS = {
  timeZone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  holidays: [],
  blocker: { value: 4, unit: 'WORKING_HOURS' },
  question: { value: 2, unit: 'WORKING_DAYS' },
} as const satisfies ResponseWindowSettingsInput;

/** "4 working hours", "1 working day". */
export const responseWindowText = (w: ResponseWindow) =>
  `${w.value} working ${w.unit === 'WORKING_HOURS' ? 'hour' : 'day'}${w.value === 1 ? '' : 's'}`;

/** `45m`, `2h`, `3d`: rounded down, never below a minute. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The labels the Inbox and the lists show for a request: "due in 2h" or "overdue 1h",
 * then "escalated" once its Delegates were added. None while paused or not sent.
 */
export function responseWindowLabels(state: ResponseWindowState, now: Date = new Date()): string[] {
  if (!state.dueAt || state.paused) return [];
  const left = Date.parse(state.dueAt) - now.getTime();
  const labels = [left > 0 ? `due in ${formatSpan(left)}` : `overdue ${formatSpan(-left)}`];
  if (state.escalationStep >= ESCALATED_FROM_STEP) labels.push('escalated');
  return labels;
}
