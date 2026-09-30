import type { AiSettingsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { AiSettingsForm } from '@/components/ai-settings-form';
import { Notice } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'AI provider' };

export default async function AiSettingsPage() {
  let settings: AiSettingsView;
  try {
    settings = await api<AiSettingsView>('/settings/ai');
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can change the AI provider.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load settings.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight">AI provider</h1>
      <p className="mt-2 text-ink-soft">
        The model that drafts Choices and Spec changes for everyone in your organization. Changes
        apply to the next request.
      </p>
      <div className="mt-8">
        <AiSettingsForm settings={settings} />
      </div>
    </section>
  );
}
