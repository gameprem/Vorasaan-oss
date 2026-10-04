import type { PromptProposalView, ProposalRedraftsView } from '@vorasaan/shared';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { PromptProposal } from '@/components/prompt-proposal';
import { loadRedrafts } from '@/components/redrafts-section';
import { SettingsLink } from '@/components/settings-dialog';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Prompt proposal' };

// A Prompt Version the AI proposed (ticket 0072), as an Admin decides it: the patterns behind
// it, the diff, the evals before and after, and Approve, Decline or Request changes.
export default async function PromptProposalPage({
  params,
}: {
  params: Promise<{ name: string; number: string }>;
}) {
  const { name, number } = await params;
  if (!/^\d+$/.test(number)) notFound();
  let view: PromptProposalView;
  let redrafts: ProposalRedraftsView | null;
  try {
    view = await api<PromptProposalView>(
      `/settings/ai/prompts/${encodeURIComponent(name)}/versions/${number}/proposal`,
    );
    redrafts = await loadRedrafts('PROMPT_VERSION', view.version.id);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403) {
      return <Notice>Only an Organization Admin can change the AI prompts.</Notice>;
    }
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load the proposal.'}
      </Notice>
    );
  }
  return (
    <section className="max-w-4xl">
      <SettingsLink
        href={`/settings/ai/prompts/${name}`}
        className="text-sm text-fg-soft hover:text-fg"
      >
        ← {name}
      </SettingsLink>
      <PromptProposal name={name} view={view} redrafts={redrafts} />
    </section>
  );
}
