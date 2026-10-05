import type { AiSettingsView, AiUsageView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { AiUsageDashboard } from '@/components/ai-usage';
import { Notice } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'AI usage' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AiUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const query = new URLSearchParams();
  if (from && DATE.test(from)) query.set('from', from);
  if (to && DATE.test(to)) query.set('to', to);
  let view: AiUsageView;
  let settings: AiSettingsView;
  try {
    [view, settings] = await Promise.all([
      api<AiUsageView>(`/settings/ai/usage${query.size ? `?${query}` : ''}`),
      api<AiSettingsView>('/settings/ai'),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can see the AI usage.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the AI usage.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">AI usage</h2>
      <p className="mt-2 text-fg-soft">
        What the AI costs, where, and what it buys, from the Receipts of its calls: tokens, an
        estimated cost from the prices you set, cache use and latency, by task, Project and model.
      </p>
      <AiUsageDashboard view={view} models={settings.models} />
    </section>
  );
}
