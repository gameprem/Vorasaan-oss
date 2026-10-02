import type { ChatAppsSettingsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { ChatAppsSettings } from '@/components/chat-apps-settings';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Chat apps' };

export default async function ChatAppsSettingsPage() {
  const me = await currentUser();
  let settings: ChatAppsSettingsView | null = null;
  if (me?.isAdmin) {
    try {
      settings = await api<ChatAppsSettingsView>('/settings/chat-apps');
    } catch (error) {
      unstable_rethrow(error);
      return (
        <Notice tone="error">
          {error instanceof ApiError ? error.message : 'Could not load the chat apps.'}
        </Notice>
      );
    }
  }

  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Chat apps</h2>
      <p className="mt-2 text-fg-soft">
        Turn on LINE, Slack or Microsoft Teams so people can link their accounts and answer Decision
        Requests there. Each chat app uses the Organization's own bot; its secrets are stored
        encrypted and never shown again. Every callback is checked against them before anything in
        it is read.
      </p>
      <div className="mt-6">
        {settings ? (
          <ChatAppsSettings apps={settings.apps} />
        ) : (
          <Notice>Only an Organization Admin can set up chat apps.</Notice>
        )}
      </div>
    </section>
  );
}
