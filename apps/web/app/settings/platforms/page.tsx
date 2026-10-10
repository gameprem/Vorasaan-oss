import type { PlatformTemplateView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { PlatformsList, PlatformTemplateEditor } from '@/components/platforms-editor';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Platforms' };

export default async function PlatformsSettingsPage() {
  let template: PlatformTemplateView;
  let isAdmin: boolean;
  try {
    const [loaded, me] = await Promise.all([
      api<PlatformTemplateView>('/settings/platform-template'),
      currentUser(),
    ]);
    template = loaded;
    isAdmin = me?.isAdmin ?? false;
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Platform template.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Platforms</h2>
      <p className="mt-2 text-fg-soft">
        The Platform template: the parts of the product a Feature can ship on, the Team Roles who
        answer for each, and the Coverage checks each one switches on. Every new Project starts with
        a copy of this list and changes its own on its Platforms tab.
      </p>
      {template.builtIn && (
        <p className="mt-2 text-sm text-fg-soft">
          This is the built-in template. Saving it makes it the Organization’s own.
        </p>
      )}
      <div className="mt-8">
        {isAdmin ? (
          <PlatformTemplateEditor platforms={template.platforms} />
        ) : (
          <>
            <Notice>
              Only an Organization Admin can change the Platform template. A Project’s POs change
              their Project’s Platforms on its Platforms tab.
            </Notice>
            <div className="mt-6">
              <PlatformsList platforms={template.platforms} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
