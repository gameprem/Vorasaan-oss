import type { DecisionRequestView, SpecProposalView } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KindBadge, Notice, relativeTime, statusText } from '@/components/bits';
import { DecideForm } from '@/components/decide-form';
import { ReviewProposal } from '@/components/review-proposal';
import { SpecDiff } from '@/components/spec-diff';
import { ApiError, api, currentUserId } from '@/lib/api';

export const metadata = { title: 'Decision Request' };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await currentUserId();

  let request: DecisionRequestView;
  let proposal: SpecProposalView | undefined;
  try {
    request = await api<DecisionRequestView>(`/decision-requests/${id}`);
    if (request.specProposal) {
      proposal = await api<SpecProposalView>(`/spec-proposals/${request.specProposal.id}`);
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this request.'}
      </Notice>
    );
  }

  const isDecider = userId !== undefined && request.decider?.id === userId;
  const decidedChoice = request.choices.find((c) => c.id === request.decision?.choiceId);

  return (
    <article className="max-w-3xl">
      <p className="text-sm text-ink-soft">
        <Link
          href={`/features/${request.featureId}`}
          className="underline-offset-2 hover:underline"
        >
          {request.featureTitle}
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <KindBadge kind={request.kind} />
        <span className="text-sm text-ink-soft">{statusText(request.status)}</span>
      </div>
      <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight">{request.title}</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Raised by {request.raiser.name} {relativeTime(request.createdAt)}
        {request.decider ? `, for ${request.decider.name} to decide` : ''}
      </p>
      <p className="mt-6 max-w-[68ch] whitespace-pre-line text-lg">{request.description}</p>

      {request.status === 'OPEN' &&
        (isDecider ? (
          <DecideForm requestId={request.id} choices={request.choices} />
        ) : (
          <div className="mt-8">
            <Notice>Waiting for {request.decider?.name ?? 'the Decider'} to decide.</Notice>
          </div>
        ))}

      {request.decision && (
        <section className="mt-10">
          <div className="relative rounded-xl border border-jade/40 bg-sheet p-5">
            <span
              aria-hidden
              className="stamp absolute -top-3 right-4 rounded border-2 border-jade bg-sheet px-2 text-sm font-semibold text-jade"
            >
              Decided
            </span>
            <h2 className="font-semibold">
              {decidedChoice
                ? `${decidedChoice.label}. ${decidedChoice.title}`
                : request.decision.customAnswer}
            </h2>
            {request.decision.rationale && (
              <p className="mt-1 text-ink-soft">{request.decision.rationale}</p>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              {request.decision.decidedBy.name}, {relativeTime(request.decision.createdAt)}
            </p>
          </div>
        </section>
      )}

      {proposal && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">
            {proposal.status === 'PENDING'
              ? 'Proposed Spec change'
              : proposal.status === 'APPROVED'
                ? 'Approved Spec change'
                : 'Rejected Spec change'}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Drafted by AI from the Decision, against Spec v{proposal.baseVersion ?? 0}.
            {proposal.status === 'PENDING' && ` ${proposal.approver.name} approves it.`}
          </p>
          <div className="mt-4">
            <SpecDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} />
          </div>
          {proposal.status === 'PENDING' && userId === proposal.approver.id && (
            <ReviewProposal proposalId={proposal.id} requestId={request.id} />
          )}
          {proposal.status === 'APPROVED' && (
            <p className="mt-4">
              <Link
                href={`/features/${request.featureId}`}
                className="font-medium text-jade underline-offset-2 hover:underline"
              >
                See the updated Spec
              </Link>
            </p>
          )}
        </section>
      )}
    </article>
  );
}
