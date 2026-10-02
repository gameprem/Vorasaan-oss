'use client';

import { useActionState } from 'react';
import {
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationActionState,
} from '@/lib/notification-actions';

const linkButton =
  'text-sm text-fg-soft underline underline-offset-2 hover:text-fg disabled:opacity-40';

function ErrorText({ state }: { state: NotificationActionState }) {
  return state.error ? (
    <p role="alert" className="mt-1 text-sm text-lacquer">
      {state.error}
    </p>
  ) : null;
}

export function MarkReadButton({ id, label }: { id: string; label: string }) {
  const [state, run, pending] = useActionState<NotificationActionState>(
    markNotificationRead.bind(null, id),
    {},
  );
  return (
    <form action={run}>
      <button type="submit" disabled={pending} className={linkButton} aria-label={label}>
        {pending ? 'Marking…' : 'Mark read'}
      </button>
      <ErrorText state={state} />
    </form>
  );
}

export function MarkAllReadButton() {
  const [state, run, pending] = useActionState<NotificationActionState>(
    markAllNotificationsRead,
    {},
  );
  return (
    <form action={run}>
      <button type="submit" disabled={pending} className={linkButton}>
        {pending ? 'Marking…' : 'Mark all read'}
      </button>
      <ErrorText state={state} />
    </form>
  );
}
