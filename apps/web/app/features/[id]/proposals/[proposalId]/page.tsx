import type { FeatureView, SpecProposalView } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Notice, relativeTime } from '@/components/bits';
import { ReviewProposal } from '@/components/review-proposal';
import { SpecDiff } from '@/components/spec-diff';
import { approveProposal, rejectProposal } from '@/lib/actions';
import { ApiError, api, currentUser } from '@/lib/api';
import { isId } from '@/lib/ids';

export const metadata = { title: 'Spec Proposal' };

const ORIGIN: Record<SpecProposalView['source'], string> = {
  AI_SUMMARY: 'Drafted by AI (from the Attachments or a Feature Suggestion)',
  DECISION: 'Drafted by AI from a Decision',
  MANUAL: 'Written by hand',
  REVERT: 'A revert',
  CONVERSATION: 'Drafted by AI in a Conversation',
};

/** Review of one Spec Proposal: the diff against the Spec it was drafted from, then approve or reject. */
export default async function ProposalPage({
  params,
}: {
  params: Promise<{ id: string; proposalId: string }>;
}) {
  const { id, proposalId } = await params;
  if (!isId(id) || !isId(proposalId)) notFound();

  let feature: FeatureView;
  let proposal: SpecProposalView;
  try {
    [feature, proposal] = await Promise.all([
      api<FeatureView>(`/features/${id}`),
      api<SpecProposalView>(`/spec-proposals/${proposalId}`),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this Spec Proposal.'}
      </Notice>
    );
  }
  if (proposal.featureId !== feature.id) notFound();
  const me = await currentUser();

  return (
    <article className="max-w-4xl">
      <p className="text-sm text-fg-soft">
        <Link href={`/features/${id}`} className="hover:underline">
          {feature.title}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {proposal.status === 'PENDING'
          ? 'Proposed Spec change'
          : proposal.status === 'APPROVED'
            ? 'Approved Spec change'
            : 'Rejected Spec change'}
      </h1>
      <p className="mt-1 text-sm text-fg-soft">
        {ORIGIN[proposal.source]}{' '}
        {proposal.baseVersion ? `against Spec v${proposal.baseVersion}` : 'as the first Spec'},{' '}
        {relativeTime(proposal.createdAt)}.
        {proposal.status === 'PENDING' && ` ${proposal.approver.name} approves it.`}
      </p>
      {proposal.decisionRequestId && (
        <p className="mt-2 text-sm">
          <Link
            href={`/requests/${proposal.decisionRequestId}`}
            className="underline underline-offset-2"
          >
            See the Decision Request
          </Link>
        </p>
      )}

      <div className="mt-6">
        <SpecDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} />
      </div>

      {proposal.status === 'PENDING' &&
        (me?.id === proposal.approver.id ? (
          <ReviewProposal
            approveAction={approveProposal.bind(null, proposal.id, proposal.decisionRequestId)}
            rejectAction={rejectProposal.bind(null, proposal.id, proposal.decisionRequestId)}
            note={
              proposal.decisionRequestId
                ? 'Rejecting keeps your Decision. Only the Spec stays as it is.'
                : 'Rejecting leaves the Spec as it is.'
            }
          />
        ) : (
          <p className="mt-6 text-fg-soft">Waiting for {proposal.approver.name} to review it.</p>
        ))}
      {proposal.status !== 'PENDING' && (
        <p className="mt-6">
          <Link
            href={`/features/${id}`}
            className="font-medium text-jade underline-offset-2 hover:underline"
          >
            Back to the Spec
          </Link>
        </p>
      )}
    </article>
  );
}
