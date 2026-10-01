import type { OrgFeatureGuidelinesView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { OrgGuidelinesEditor } from '@/components/guidelines-editor';
import { EffectiveGuidelinesList } from '@/components/guidelines-list';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Feature Guidelines' };

export default async function FeatureGuidelinesSettingsPage() {
  let guidelines: OrgFeatureGuidelinesView;
  let isAdmin: boolean;
  try {
    const [loaded, me] = await Promise.all([
      api<OrgFeatureGuidelinesView>('/settings/feature-guidelines'),
      currentUser(),
    ]);
    guidelines = loaded;
    isAdmin = me?.isAdmin ?? false;
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Feature Guidelines.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">Feature Guidelines</h2>
      <p className="mt-2 text-fg-soft">
        The criteria a new Feature must meet for the business: KPIs it serves, constraints it
        respects and sections its Spec must have. Every Project starts from this list, in this
        order, and can edit, hide or add criteria on its Guidelines tab.
      </p>
      <div className="mt-8">
        {isAdmin ? (
          <OrgGuidelinesEditor criteria={guidelines.criteria} />
        ) : (
          <>
            <Notice>
              Only an Organization Admin can change the Feature Guidelines. A Project’s POs adjust
              them for their Project on its Guidelines tab.
            </Notice>
            <div className="mt-6">
              {guidelines.criteria.length === 0 ? (
                <p className="text-fg-soft">The Organization has no Feature Guidelines yet.</p>
              ) : (
                <EffectiveGuidelinesList
                  showOrigin={false}
                  criteria={guidelines.criteria.map((c) => ({
                    ...c,
                    origin: 'ORGANIZATION',
                    overridesId: null,
                  }))}
                />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
