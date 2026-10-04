import type { PromptsView } from '@vorasaan/shared';
import { unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { AnalysisSettings, PromptList } from '@/components/prompt-versions';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'AI prompts' };

export default async function PromptsPage() {
  let view: PromptsView;
  try {
    view = await api<PromptsView>('/settings/ai/prompts');
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can change the AI prompts.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the prompts.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-3xl">
      <h2 className="text-[26px] font-semibold tracking-tight">AI prompts</h2>
      <p className="mt-2 text-fg-soft">
        The instructions the AI follows for each kind of work. The built-in default is used until an
        Admin approves a Prompt Version of your own; run evals on a version before you approve it,
        and roll back at any time. The AI also reads what people did with its proposals and proposes
        better versions; those change nothing until an Admin approves them.
      </p>
      <AnalysisSettings analysisAfter={view.analysisAfter} />
      <PromptList prompts={view.prompts} />
    </section>
  );
}
