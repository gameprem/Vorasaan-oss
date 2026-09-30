import type {
  DecisionRequestView,
  FeatureSummaryView,
  PersonRef,
  RequestMessageKind,
  RoleOwnerView,
  SpecProposalView,
  TeamRole,
  TeamView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { KindBadge, Notice, relativeTime, statusText } from '@/components/bits';
import { DecideForm } from '@/components/decide-form';
import { DraftReview } from '@/components/draft-review';
import {
  ClaimButton,
  MessageForm,
  ReassignForm,
  WithdrawButton,
} from '@/components/request-actions';
import { ReviewProposal } from '@/components/review-proposal';
import { SpecDiff } from '@/components/spec-diff';
import { ROLE_LABEL } from '@/components/ui';
import { approveProposal, rejectProposal } from '@/lib/actions';
import { ApiError, api, currentUser } from '@/lib/api';

export const metadata = { title: 'Decision Request' };

const MESSAGE_LABEL: Record<RequestMessageKind, string> = {
  QUESTION: 'asked for more info',
  ANSWER: 'answered',
  NOTE: 'added a note',
};

const names = (people: PersonRef[]) =>
  people.length <= 1
    ? (people[0]?.name ?? '')
    : `${people
        .slice(0, -1)
        .map((p) => p.name)
        .join(', ')} and ${people.at(-1)?.name}`;

/**
 * Who can receive the request for each Team Role, as the server routes it: the Feature's
 * Role Owners for the role or, when it has none, the Team members holding it. Never the Raiser.
 */
function candidatesByRole(owners: RoleOwnerView[], team: TeamView, raiserId: string) {
  const byRole: Partial<Record<TeamRole, PersonRef[]>> = {};
  const roles = new Set<TeamRole>([
    ...owners.map((o) => o.role),
    ...team.members.flatMap((m) => m.roles),
  ]);
  for (const role of roles) {
    const owning = owners
      .filter((o) => o.role === role && o.userId !== raiserId)
      .map((o) => ({ id: o.userId, name: o.name }));
    byRole[role] = owning.length
      ? owning
      : team.members
          .filter((m) => m.roles.includes(role) && m.userId !== raiserId)
          .map((m) => ({ id: m.userId, name: m.name }));
  }
  return byRole;
}

async function loadTeam(featureId: string) {
  const feature = await api<FeatureSummaryView>(`/features/${featureId}`);
  return api<TeamView>(`/teams/${feature.teamId}`);
}

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = (await currentUser())?.id;

  let request: DecisionRequestView;
  let proposal: SpecProposalView | undefined;
  try {
    request = await api<DecisionRequestView>(`/decision-requests/${id}`);
    if (request.specProposal) {
      proposal = await api<SpecProposalView>(`/spec-proposals/${request.specProposal.id}`);
    }
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this request.'}
      </Notice>
    );
  }

  const isRaiser = userId !== undefined && request.raiser.id === userId;
  const isDecider = userId !== undefined && request.decider?.id === userId;
  const isRecipient = request.recipients.some((r) => r.id === userId);
  // A recipient of a request nobody has Claimed may decide or ask directly, which Claims it.
  const canAct = isDecider || (request.decider === null && isRecipient);
  const active = request.status === 'OPEN' || request.status === 'NEEDS_INFO';
  const roleLabel = ROLE_LABEL[request.deciderRole];
  const decidedChoice = request.choices.find((c) => c.id === request.decision?.choiceId);

  // Only the views that need them load the Team: the draft review and the Decider's reassign.
  let draftCandidates: Partial<Record<TeamRole, PersonRef[]>> | undefined;
  let reassignCandidates: PersonRef[] | undefined;
  let teamError: string | undefined;
  const needsDraft = request.status === 'DRAFT' && isRaiser;
  const needsReassign = request.status === 'OPEN' && isDecider;
  if (needsDraft || needsReassign) {
    try {
      const [team, owners] = await Promise.all([
        loadTeam(request.featureId),
        needsDraft
          ? api<RoleOwnerView[]>(`/features/${request.featureId}/role-owners`)
          : Promise.resolve([]),
      ]);
      if (needsDraft) draftCandidates = candidatesByRole(owners, team, request.raiser.id);
      reassignCandidates = team.members
        .filter(
          (m) =>
            m.roles.includes(request.deciderRole) &&
            m.userId !== request.raiser.id &&
            m.userId !== userId,
        )
        .map((m) => ({ id: m.userId, name: m.name }));
    } catch (error) {
      unstable_rethrow(error);
      teamError =
        error instanceof ApiError ? error.message : 'Could not load the Team for this request.';
    }
  }

  let routing = '';
  if (request.decider) routing = `, for ${request.decider.name} to decide`;
  else if (request.recipients.length > 1)
    routing = `, sent to ${names(request.recipients)}. The first ${roleLabel} to Claim it decides`;

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
        Raised by {request.raiser.name} {relativeTime(request.submittedAt ?? request.createdAt)}
        {routing}.
      </p>
      <p className="mt-6 max-w-[68ch] whitespace-pre-line text-lg">{request.description}</p>

      {teamError && (
        <div className="mt-8">
          <Notice tone="error">{teamError}</Notice>
        </div>
      )}

      {request.status === 'DRAFT' &&
        (isRaiser ? (
          draftCandidates && (
            <>
              <div className="mt-8">
                <Notice>
                  This is a draft. Nobody sees it until you send it. Review it, then send it.
                </Notice>
              </div>
              <DraftReview request={request} candidatesByRole={draftCandidates} />
              <div className="mt-6">
                <WithdrawButton requestId={request.id} draft />
              </div>
            </>
          )
        ) : (
          <div className="mt-8">
            <Notice>{request.raiser.name} has not sent this draft yet.</Notice>
          </div>
        ))}

      {request.status === 'OPEN' && request.canClaim && (
        <section
          aria-labelledby="claim"
          className="mt-8 rounded-xl border border-rule bg-sheet p-5"
        >
          <h2 id="claim" className="font-semibold">
            {request.decider ? `Routed to ${request.decider.name}` : 'Nobody has Claimed it yet'}
          </h2>
          <p className="mt-1 mb-4 text-ink-soft">
            {request.decider
              ? `You hold the ${roleLabel} Team Role, so you can Claim it and decide instead.`
              : `Claim it to become the Decider. The others stop seeing it in their Inbox.${canAct ? ' You can also decide or ask for more info directly.' : ''}`}
          </p>
          <ClaimButton requestId={request.id} />
        </section>
      )}

      {request.status === 'OPEN' &&
        (canAct ? (
          <>
            <DecideForm requestId={request.id} choices={request.choices} />
            <section aria-labelledby="more" className="mt-10 space-y-8 border-t border-rule pt-8">
              <h2 id="more" className="text-lg font-semibold">
                Not ready to decide?
              </h2>
              <MessageForm requestId={request.id} kind="QUESTION" />
              {isDecider && reassignCandidates && (
                <div>
                  <h3 className="text-sm font-medium">Reassign to another {roleLabel}</h3>
                  <div className="mt-2">
                    <ReassignForm
                      requestId={request.id}
                      candidates={reassignCandidates}
                      roleLabel={roleLabel}
                    />
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          !request.canClaim && (
            <div className="mt-8">
              <Notice>
                Waiting for{' '}
                {request.decider?.name ?? `one of ${names(request.recipients)} to Claim it`}.
              </Notice>
            </div>
          )
        ))}

      {request.status === 'NEEDS_INFO' && (
        <div className="mt-8">
          <Notice>
            {request.decider?.name ?? 'The Decider'} asked for more info. Waiting for{' '}
            {isRaiser ? 'your answer' : `${request.raiser.name} to answer`}.
          </Notice>
        </div>
      )}

      {(request.messages.length > 0 || (active && (isRaiser || canAct))) && (
        <section aria-labelledby="thread" className="mt-10">
          <h2 id="thread" className="text-lg font-semibold">
            Thread
          </h2>
          {request.messages.length === 0 ? (
            <p className="mt-2 text-ink-soft">
              No messages yet. Questions, answers and notes between the Decider and the Raiser
              appear here.
            </p>
          ) : (
            <ol className="mt-4 space-y-4">
              {request.messages.map((m) => (
                <li
                  key={m.id}
                  className={`rounded-xl border p-4 ${
                    m.kind === 'QUESTION' ? 'border-seal/30 bg-seal-wash' : 'border-rule bg-sheet'
                  }`}
                >
                  <p className="text-sm text-ink-soft">
                    <span className="font-medium text-ink">{m.author.name}</span>{' '}
                    {MESSAGE_LABEL[m.kind]} {relativeTime(m.createdAt)}
                  </p>
                  <p className="mt-1 max-w-[68ch] whitespace-pre-line">{m.body}</p>
                </li>
              ))}
            </ol>
          )}
          {request.status === 'NEEDS_INFO' && isRaiser && (
            <div className="mt-6">
              <MessageForm requestId={request.id} kind="ANSWER" />
            </div>
          )}
          {active && (isRaiser || canAct) && (
            <div className="mt-6">
              <MessageForm requestId={request.id} kind="NOTE" />
            </div>
          )}
        </section>
      )}

      {active && isRaiser && (
        <div className="mt-10 border-t border-rule pt-6">
          <WithdrawButton requestId={request.id} />
        </div>
      )}

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
              Decided by {request.decision.decidedBy.name}
              {request.decision.onBehalfOf && ` on behalf of ${request.decision.onBehalfOf.name}`}{' '}
              {relativeTime(request.decision.createdAt)}
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
            <ReviewProposal
              approveAction={approveProposal.bind(null, proposal.id, request.id)}
              rejectAction={rejectProposal.bind(null, proposal.id, request.id)}
              note="Rejecting keeps your Decision. Only the Spec stays as it is."
            />
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
