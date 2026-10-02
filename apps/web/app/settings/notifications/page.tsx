import type { MyChatAppsView, ResponseWindowSettingsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { ChatAccountsSettings } from '@/components/chat-accounts-settings';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Notifications' };

export default async function NotificationsSettingsPage() {
  let view: MyChatAppsView;
  let organizationTimeZone: string;
  try {
    const [mine, calendar] = await Promise.all([
      api<MyChatAppsView>('/me/chat-apps'),
      api<ResponseWindowSettingsView>('/settings/response-windows'),
    ]);
    view = mine;
    organizationTimeZone = calendar.timeZone;
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load your notification settings.'}
      </Notice>
    );
  }

  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Notifications</h2>
      <p className="mt-2 text-fg-soft">
        Your Inbox and Notifications are always in Vorasaan. You can also get them in a chat app.
      </p>
      <div className="mt-8">
        <ChatAccountsSettings view={view} organizationTimeZone={organizationTimeZone} />
      </div>
    </section>
  );
}
