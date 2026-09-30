import type { OrgFeatureGuidelinesView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { OrgGuidelinesEditor } from '@/components/guidelines-editor';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Feature Guidelines' };

export default async function FeatureGuidelinesSettingsPage() {
  let guidelines: OrgFeatureGuidelinesView;
  try {
    guidelines = await api<OrgFeatureGuidelinesView>('/settings/feature-guidelines');
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return (
        <Notice>
          Only an Organization Admin can change the Feature Guidelines. A Project’s POs adjust them
          for their Project on its Guidelines tab.
        </Notice>
      );
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the Feature Guidelines.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Feature Guidelines</h1>
      <p className="mt-2 text-ink-soft">
        The criteria a new Feature must meet for the business: KPIs it serves, constraints it
        respects and sections its Spec must have. Every Project starts from this list, in this
        order, and can edit, hide or add criteria on its Guidelines tab.
      </p>
      <div className="mt-8">
        <OrgGuidelinesEditor criteria={guidelines.criteria} />
      </div>
    </section>
  );
}
