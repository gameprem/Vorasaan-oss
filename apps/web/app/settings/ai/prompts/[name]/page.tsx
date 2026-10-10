import type { AiSettingsView, PromptDetailView } from '@vorasaan/shared';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { PromptDetail } from '@/components/prompt-versions';
import { SettingsLink } from '@/components/settings-dialog';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'AI prompt' };

export default async function PromptPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  let prompt: PromptDetailView;
  let ai: AiSettingsView;
  try {
    [prompt, ai] = await Promise.all([
      api<PromptDetailView>(`/settings/ai/prompts/${encodeURIComponent(name)}`),
      api<AiSettingsView>('/settings/ai'),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can change the AI prompts.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the prompt.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-4xl">
      <SettingsLink href="/settings/ai/prompts" className="text-sm text-fg-soft hover:text-fg">
        ← AI prompts
      </SettingsLink>
      <PromptDetail prompt={prompt} models={ai.models} />
    </section>
  );
}
