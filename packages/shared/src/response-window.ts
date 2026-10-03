import { z } from 'zod';
import { RequestHistoryKind, ResponseWindowUnit } from './enums.ts';

// Response Windows (ADR 0011, ticket 0055): how long a Decision Request may wait for a
// decision, in the Organization's working time, before it escalates.

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/** How many steps an escalation has: remind, add Delegates, tell the Raiser and Tech Leads. */
export const ESCALATION_STEPS = 3;
/** From this step on a request counts as "escalated": its Delegates were added. */
export const ESCALATED_FROM_STEP = 2;

/** A window length, such as 4 working hours or 2 working days. */
export const ResponseWindow = z.strictObject({
  value: z.int().min(1).max(1000),
  unit: ResponseWindowUnit,
});
export type ResponseWindow = z.infer<typeof ResponseWindow>;

/** `HH:MM`, 24-hour, in the Organization's time zone. */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, such as 09:00');

export const TimeZone = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Not a known time zone');

export const Holiday = z.strictObject({
  date: z.iso.date(),
  name: z.string().trim().min(1).max(200),
});
export type Holiday = z.infer<typeof Holiday>;

/** Minutes after midnight of an `HH:MM`. */
export const minutesOfDay = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** `HH:MM` of minutes after midnight. */
export const timeOfDay = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The Organization's Working Time, minus the holidays. Working days are ISO weekdays. */
const workingTimeShape = {
  timeZone: TimeZone,
  workingDays: z
    .array(z.int().min(1).max(7))
    .min(1, 'Pick at least one working day')
    .refine((days) => new Set(days).size === days.length, 'A working day appears twice'),
  workStart: TimeOfDay,
  workEnd: TimeOfDay,
};
const endsAfterStart = (s: { workStart: string; workEnd: string }) =>
  minutesOfDay(s.workEnd) > minutesOfDay(s.workStart);
const ENDS_AFTER_START = { message: 'Working hours must end after they start', path: ['workEnd'] };

/**
 * The time zone, working days and working hours on their own, as first-run setup asks for
 * them (ticket 0063). Saved into the same settings as `ResponseWindowSettingsInput`.
 */
export const WorkingTimeInput = z
  .strictObject(workingTimeShape)
  .refine(endsAfterStart, ENDS_AFTER_START);
export type WorkingTimeInput = z.infer<typeof WorkingTimeInput>;

/**
 * `PUT /settings/response-windows` (Admins): the Organization's working calendar and its
 * default windows. Working days are ISO weekdays (1 = Monday ... 7 = Sunday).
 */
export const ResponseWindowSettingsInput = z
  .strictObject({
    ...workingTimeShape,
    holidays: z
      .array(Holiday)
      .max(400)
      .refine(
        (list) => new Set(list.map((h) => h.date)).size === list.length,
        'Two holidays share a date',
      ),
    blocker: ResponseWindow,
    question: ResponseWindow,
  })
  .refine(endsAfterStart, ENDS_AFTER_START);
export type ResponseWindowSettingsInput = z.infer<typeof ResponseWindowSettingsInput>;

/** `GET /settings/response-windows` (every member of the Organization). */
export const ResponseWindowSettingsView = z.object({
  organizationId: Id,
  timeZone: z.string(),
  workingDays: z.array(z.int().min(1).max(7)),
  workStart: TimeOfDay,
  workEnd: TimeOfDay,
  /** Sorted by date. */
  holidays: z.array(Holiday),
  blocker: ResponseWindow,
  question: ResponseWindow,
});
export type ResponseWindowSettingsView = z.infer<typeof ResponseWindowSettingsView>;

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

/** `PUT /projects/:id/response-windows` (Admins): null keeps the Organization's default. */
export const ProjectResponseWindowsInput = z.strictObject({
  blocker: ResponseWindow.nullable(),
  question: ResponseWindow.nullable(),
});
export type ProjectResponseWindowsInput = z.infer<typeof ProjectResponseWindowsInput>;

/** `GET /projects/:id/response-windows`: the Project's own windows and the ones in effect. */
export const ProjectResponseWindowsView = z.object({
  projectId: Id,
  override: ProjectResponseWindowsInput,
  effective: z.object({ blocker: ResponseWindow, question: ResponseWindow }),
});
export type ProjectResponseWindowsView = z.infer<typeof ProjectResponseWindowsView>;

/** Where a sent Decision Request stands against its Response Window. */
export const ResponseWindowState = z.object({
  /** When the window runs out; null until sent. Moves later after a NEEDS_INFO pause. */
  dueAt: Timestamp.nullable(),
  /** In NEEDS_INFO: the clock is stopped until the Raiser answers. */
  paused: z.boolean(),
  /** 0 none, 1 reminded, 2 Delegates added, 3 Raiser and Tech Leads told. */
  escalationStep: z.int().min(0).max(ESCALATION_STEPS),
});
export type ResponseWindowState = z.infer<typeof ResponseWindowState>;

/** One escalation step in a Decision Request's history, with who it reached. */
export const RequestHistoryEntryView = z.object({
  kind: RequestHistoryKind,
  people: z.array(z.object({ id: Id, name: z.string() })),
  createdAt: Timestamp,
});
export type RequestHistoryEntryView = z.infer<typeof RequestHistoryEntryView>;

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
