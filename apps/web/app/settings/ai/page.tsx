import type { AiSettingsView, ReceiptSettingsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { AiModelsSettings } from '@/components/ai-models-settings';
import { Notice } from '@/components/bits';
import { ReceiptsSettings } from '@/components/receipts-settings';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'AI models' };

export default async function AiSettingsPage() {
  let settings: AiSettingsView;
  let receipts: ReceiptSettingsView;
  try {
    [settings, receipts] = await Promise.all([
      api<AiSettingsView>('/settings/ai'),
      api<ReceiptSettingsView>('/settings/ai/receipts'),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can change the AI models.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load settings.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">AI models</h2>
      <p className="mt-2 text-fg-soft">
        The AI providers your organization connects, the models people may use, the model each kind
        of AI work runs on, and the Receipts its calls leave.
      </p>
      <div className="mt-8 space-y-12">
        <AiModelsSettings settings={settings} />
        <ReceiptsSettings settings={receipts} />
      </div>
    </section>
  );
}
