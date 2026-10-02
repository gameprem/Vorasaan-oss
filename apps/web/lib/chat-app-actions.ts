'use server';

import {
  ChatAppSettingsInput,
  type ChatLinkCodeView,
  ChatPreferencesInput,
  ChatProvider,
  chatProviderSlug,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';

// Settings → Chat apps (Admins) and Settings → Notifications (each person), ticket 0057.
// They forward to the API as the signed-in user; the API checks who may do what. Secrets
// typed into the forms pass through here once, on their way to be encrypted, and are
// never read back.

export type ChatActionState = { error?: string; ok?: boolean };

const firstIssue = (error: { issues: { message: string }[] }) =>
  error.issues[0]?.message ?? 'Check the form and try again.';

async function attempt(run: () => Promise<unknown>): Promise<ChatActionState> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/chat-apps');
  revalidatePath('/settings/notifications');
  return { ok: true };
}

/** Path segment of a provider from the browser, checked before it reaches a URL. */
function slugOf(provider: unknown) {
  const parsed = ChatProvider.safeParse(provider);
  return parsed.success ? chatProviderSlug(parsed.data) : null;
}

export async function saveChatAppSettings(input: ChatAppSettingsInput): Promise<ChatActionState> {
  const parsed = ChatAppSettingsInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(() => api('/settings/chat-apps', { method: 'PUT', body: parsed.data }));
}

export async function turnOffChatApp(provider: ChatProvider): Promise<ChatActionState> {
  const slug = slugOf(provider);
  if (!slug) return { error: 'Unknown chat app.' };
  return attempt(() => api(`/settings/chat-apps/${slug}`, { method: 'DELETE' }));
}

export async function createChatLinkCode(
  provider: ChatProvider,
): Promise<{ error?: string; code?: ChatLinkCodeView }> {
  const slug = slugOf(provider);
  if (!slug) return { error: 'Unknown chat app.' };
  try {
    return {
      code: await api<ChatLinkCodeView>(`/me/chat-apps/${slug}/link-code`, { method: 'POST' }),
    };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function unlinkChatAccount(provider: ChatProvider): Promise<ChatActionState> {
  const slug = slugOf(provider);
  if (!slug) return { error: 'Unknown chat app.' };
  return attempt(() => api(`/me/chat-apps/${slug}`, { method: 'DELETE' }));
}

export async function saveChatPreferences(input: ChatPreferencesInput): Promise<ChatActionState> {
  const parsed = ChatPreferencesInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(() => api('/me/chat-preferences', { method: 'PUT', body: parsed.data }));
}
