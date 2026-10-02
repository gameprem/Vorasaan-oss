import type { ChatEventKind } from '@vorasaan/shared';

// Whether something may go to a person's chat apps now (ticket 0057). Ticket 0058
// asks this before sending each card; what is held back stays in the Inbox.

export type ChatDeliveryPreferences = {
  events: readonly ChatEventKind[];
  /** Minutes after local midnight; both null when there are no quiet hours. */
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  /** The time zone quiet hours are counted in. */
  timeZone: string;
};

export type ChatDelivery = 'send' | 'not-chosen' | 'quiet-hours';

/** Minutes after midnight of `at` in `timeZone`. */
export function localMinute(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Quiet from the start (inclusive) to the end (exclusive), across midnight when end < start. */
export function inQuietHours(prefs: ChatDeliveryPreferences, at: Date): boolean {
  const { quietStartMinute: start, quietEndMinute: end } = prefs;
  if (start === null || end === null || start === end) return false;
  const now = localMinute(at, prefs.timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function chatDelivery(
  prefs: ChatDeliveryPreferences,
  kind: ChatEventKind,
  at: Date,
): ChatDelivery {
  if (!prefs.events.includes(kind)) return 'not-chosen';
  return inQuietHours(prefs, at) ? 'quiet-hours' : 'send';
}
