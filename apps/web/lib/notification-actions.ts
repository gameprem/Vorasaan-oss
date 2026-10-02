'use server';

import type { NotificationView, ReadAllNotificationsResult } from '@vorasaan/shared';
import { refresh } from 'next/cache';
import { ApiError, api } from './api';

// Notification actions. The API only lets people mark their own Notifications read.

export type NotificationActionState = { error?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(fn: () => Promise<unknown>): Promise<NotificationActionState> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  // Nothing here is cached (every API call is no-store): re-render the page and header.
  refresh();
  return {};
}

export async function markNotificationRead(id: string): Promise<NotificationActionState> {
  if (!UUID.test(id)) return { error: 'Unknown Notification.' };
  return run(() => api<NotificationView>(`/notifications/${id}/read`, { method: 'POST' }));
}

export async function markAllNotificationsRead(): Promise<NotificationActionState> {
  return run(() => api<ReadAllNotificationsResult>('/notifications/read-all', { method: 'POST' }));
}
