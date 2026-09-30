'use client';

import { NotificationCreatedEvent, type ServerEventName } from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { notificationText } from './notification-text';

// Listens to the signed-in user's event stream (through the same-origin /api/events
// bridge) and re-renders the current route when their Inbox Items or Notifications
// change, so the Inbox and the header's unread count stay live without a reload.

const INBOX_CHANGED: ServerEventName = 'inbox.changed';
const NOTIFICATION_CREATED: ServerEventName = 'notification.created';
/** Backoff between reconnects: 1 s, 2 s, 4 s ... capped at 30 s; give up after 8 in a row. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 8;
/** Several events often arrive together (one Decision touches Inbox and Notifications). */
const REFRESH_DEBOUNCE_MS = 250;

export function LiveUpdates() {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState('');
  const [gaveUp, setGaveUp] = useState(false);
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    let source: EventSource | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let idle = false; // gave up after MAX_ATTEMPTS

    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (stopped) return;
      idle = false;
      setGaveUp(false);
      const es = new EventSource('/api/events');
      source = es;
      es.onopen = () => {
        // Anything may have happened while we were disconnected.
        if (attempts > 0) refresh();
        attempts = 0;
      };
      es.addEventListener(INBOX_CHANGED, refresh);
      es.addEventListener(NOTIFICATION_CREATED, (e) => {
        refresh();
        let data: unknown;
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {}
        const parsed = NotificationCreatedEvent.safeParse(data);
        setAnnouncement(
          `New Notification: ${parsed.success ? notificationText(parsed.data.notification) : 'open your Inbox.'}`,
        );
      });
      es.onerror = () => {
        // Take reconnecting over from the browser so it is bounded and backs off.
        es.close();
        if (source === es) source = null;
        if (stopped) return;
        if (attempts >= MAX_ATTEMPTS) {
          idle = true;
          setGaveUp(true);
          return;
        }
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
        attempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    retry.current = () => {
      if (source || stopped) return;
      clearTimeout(reconnectTimer);
      attempts = 0;
      connect();
    };
    // Coming back online or to the tab is a good moment to try again, only once given up
    // (a scheduled backoff is left alone).
    const wake = () => {
      if (idle && document.visibilityState === 'visible') retry.current();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);

    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer);
      source?.close();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [router]);

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {gaveUp && (
        <button
          type="button"
          onClick={() => retry.current()}
          className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
          title="Live updates stopped after several failed attempts"
        >
          Live updates paused. Reconnect
        </button>
      )}
    </>
  );
}
