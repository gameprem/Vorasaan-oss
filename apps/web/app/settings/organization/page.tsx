import { CHAT_LANGUAGE_LABEL, type OrganizationSettingsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { OrganizationLanguageForm } from '@/components/organization-settings';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Organization' };

export default async function OrganizationSettingsPage() {
  let settings: OrganizationSettingsView;
  let isAdmin: boolean;
  try {
    const [loaded, me] = await Promise.all([
      api<OrganizationSettingsView>('/settings/organization'),
      currentUser(),
    ]);
    settings = loaded;
    isAdmin = me?.isAdmin ?? false;
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Organization settings.'}
      </Notice>
    );
  }

  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">{settings.name}</h2>
      <p className="mt-2 text-fg-soft">
        The Organization's language is the one chat app cards and bot replies use for anyone who
        hasn't picked their own in Settings → Notifications. Its time zone and working hours are in
        Response Windows.
      </p>
      <div className="mt-8">
        {isAdmin ? (
          <OrganizationLanguageForm language={settings.language} />
        ) : (
          <>
            <Notice>Only an Organization Admin can change the Organization's language.</Notice>
            <dl className="mt-6 grid grid-cols-[10rem_1fr] gap-y-2">
              <dt className="text-fg-soft">Language</dt>
              <dd>{CHAT_LANGUAGE_LABEL[settings.language]}</dd>
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
