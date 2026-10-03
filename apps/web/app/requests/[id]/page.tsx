import type {
  DecisionRequestView,
  FeatureSummaryView,
  PersonRef,
  ProjectResponseWindowsView,
  ProposalRedraftsView,
  RequestHistoryKind,
  RequestMessageKind,
  ResponseWindow,
  RoleOwnerView,
  SpecProposalView,
  TeamRole,
  TeamView,
} from '@vorasaan/shared';
import { DECISION_SOURCE_LABEL } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import {
  KindBadge,
  Notice,
  ResponseWindowLabels,
  relativeTime,
  statusText,
} from '@/components/bits';
import { DecideForm } from '@/components/decide-form';
import { DraftReview } from '@/components/draft-review';
import { ProposalRedrafts } from '@/components/redrafts';
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
import { choicePointers, sectionPointers } from '@/lib/redrafts';

export const metadata = { title: 'Decision Request' };

const MESSAGE_LABEL: Record<RequestMessageKind, string> = {
  QUESTION: 'asked for more info',
  ANSWER: 'answered',
  NOTE: 'added a note',
};

/** One line per escalation step (ticket 0055), given who it reached. */
const ESCALATION_TEXT: Record<RequestHistoryKind, (who: string) => string> = {
  REMINDED: (who) => `Response Window ran out: ${who || 'nobody'} reminded`,
  DELEGATES_ADDED: (who) =>
    who ? `Sent to ${who} as Delegate` : 'No active Delegate to send it to',
  OVERDUE_REPORTED: (who) => `Overdue: ${who || 'nobody'} told`,
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

/** The request's Team and, for the draft review, the Response Window it gets by default. */
async function loadTeam(featureId: string, kind: DecisionRequestView['kind'], withWindow: boolean) {
  const feature = await api<FeatureSummaryView>(`/features/${featureId}`);
  const [team, windows] = await Promise.all([
    api<TeamView>(`/teams/${feature.teamId}`),
    withWindow
      ? api<ProjectResponseWindowsView>(`/projects/${feature.projectId}/response-windows`)
      : undefined,
  ]);
  const window =
    windows && (kind === 'BLOCKER' ? windows.effective.blocker : windows.effective.question);
  return { team, window };
}

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = (await currentUser())?.id;

  let request: DecisionRequestView;
  let proposal: SpecProposalView | undefined;
  let choiceRedrafts: ProposalRedraftsView | undefined;
  let proposalRedrafts: ProposalRedraftsView | undefined;
  try {
    request = await api<DecisionRequestView>(`/decision-requests/${id}`);
    if (request.specProposal) {
      [proposal, proposalRedrafts] = await Promise.all([
        api<SpecProposalView>(`/spec-proposals/${request.specProposal.id}`),
        api<ProposalRedraftsView>(`/spec-proposals/${request.specProposal.id}/redrafts`),
      ]);
    }
    if (request.choices.length > 0) {
      choiceRedrafts = await api<ProposalRedraftsView>(`/decision-requests/${id}/choices/redrafts`);
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
  let draftWindow: ResponseWindow | undefined;
  let reassignCandidates: PersonRef[] | undefined;
  let teamError: string | undefined;
  const needsDraft = request.status === 'DRAFT' && isRaiser;
  const needsReassign = request.status === 'OPEN' && isDecider;
  if (needsDraft || needsReassign) {
    try {
      const [{ team, window }, owners] = await Promise.all([
        loadTeam(request.featureId, request.kind, needsDraft),
        needsDraft
          ? api<RoleOwnerView[]>(`/features/${request.featureId}/role-owners`)
          : Promise.resolve([]),
      ]);
      if (needsDraft) draftCandidates = candidatesByRole(owners, team, request.raiser.id);
      draftWindow = window;
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
      <p className="text-sm text-fg-soft">
        <Link
          href={`/features/${request.featureId}`}
          className="underline-offset-2 hover:underline"
        >
          {request.featureTitle}
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <KindBadge kind={request.kind} />
        <span className="text-sm text-fg-soft">{statusText(request.status)}</span>
        {request.status === 'OPEN' && <ResponseWindowLabels state={request.responseWindow} />}
      </div>
      <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight">{request.title}</h1>
      <p className="mt-2 text-sm text-fg-soft">
        Raised by {request.raiser.name} {relativeTime(request.submittedAt ?? request.createdAt)}
        {routing}.
      </p>
      <p className="mt-6 max-w-[68ch] whitespace-pre-line text-lg">{request.description}</p>

      {request.history.length > 0 && (
        <section aria-labelledby="escalation-heading" className="mt-8">
          <h2 id="escalation-heading" className="text-lg font-semibold">
            Escalation
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-fg-soft">
            {request.history.map((h) => (
              <li key={h.kind}>
                {ESCALATION_TEXT[h.kind](names(h.people))} {relativeTime(h.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      )}

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
              {choiceRedrafts && (
                <section aria-label="Redrafts of the Choices" className="mt-6">
                  <ProposalRedrafts
                    kind="CHOICES"
                    proposalId={request.id}
                    redrafts={choiceRedrafts}
                    pointers={choicePointers(request.choices)}
                  />
                </section>
              )}
              <DraftReview
                // A Redraft brings new Choices: the review starts again from them.
                key={request.choices.map((c) => c.id).join()}
                request={request}
                candidatesByRole={draftCandidates}
                defaultWindow={draftWindow}
              />
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
        <section aria-labelledby="claim" className="mt-8 rounded-card bg-rail p-5">
          <h2 id="claim" className="font-semibold">
            {request.decider ? `Routed to ${request.decider.name}` : 'Nobody has Claimed it yet'}
          </h2>
          <p className="mt-1 mb-4 text-fg-soft">
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
            <DecideForm
              key={request.choices.map((c) => c.id).join()}
              requestId={request.id}
              choices={request.choices}
            />
            {choiceRedrafts && (
              <section aria-label="Redrafts of the Choices" className="mt-6">
                <ProposalRedrafts
                  kind="CHOICES"
                  proposalId={request.id}
                  redrafts={choiceRedrafts}
                  pointers={choicePointers(request.choices)}
                />
              </section>
            )}
            <section aria-labelledby="more" className="mt-10 space-y-8 pt-8">
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
            <p className="mt-2 text-fg-soft">
              No messages yet. Questions, answers and notes between the Decider and the Raiser
              appear here.
            </p>
          ) : (
            <ol className="mt-4 space-y-4">
              {request.messages.map((m) => (
                <li
                  key={m.id}
                  className={`rounded-card p-4 ${
                    m.kind === 'QUESTION' ? 'bg-saffron-wash' : 'bg-rail'
                  }`}
                >
                  <p className="text-sm text-fg-soft">
                    <span className="font-medium text-fg">{m.author.name}</span>{' '}
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
        <div className="mt-10 pt-6">
          <WithdrawButton requestId={request.id} />
        </div>
      )}

      {request.decision && (
        <section className="mt-10">
          <div className="relative rounded-card bg-jade-wash p-5">
            <span
              aria-hidden
              className="stamp absolute -top-3 right-4 rounded-full bg-jade px-3 text-on-ink text-sm font-semibold"
            >
              Decided
            </span>
            <h2 className="font-semibold">
              {decidedChoice
                ? `${decidedChoice.label}. ${decidedChoice.title}`
                : request.decision.customAnswer}
            </h2>
            {request.decision.rationale && (
              <p className="mt-1 text-fg-soft">{request.decision.rationale}</p>
            )}
            <p className="mt-2 text-sm text-fg-soft">
              Decided by {request.decision.decidedBy.name}
              {request.decision.onBehalfOf && ` on behalf of ${request.decision.onBehalfOf.name}`}
              {request.decision.source !== 'WEB' &&
                ` in ${DECISION_SOURCE_LABEL[request.decision.source]}`}{' '}
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
          <p className="mt-1 text-sm text-fg-soft">
            Drafted by AI from the Decision, against Spec v{proposal.baseVersion ?? 0}.
            {proposal.status === 'PENDING' && ` ${proposal.approver.name} approves it.`}
          </p>
          <div className="mt-4">
            <SpecDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} />
          </div>
          {proposalRedrafts && (
            <div className="mt-4">
              <ProposalRedrafts
                kind="SPEC_PROPOSAL"
                proposalId={proposal.id}
                redrafts={proposalRedrafts}
                pointers={sectionPointers(proposal.proposedMarkdown)}
              />
            </div>
          )}
          {proposal.status === 'PENDING' && userId === proposal.approver.id && (
            <ReviewProposal
              approveLabel={
                proposalRedrafts && proposalRedrafts.current > 1
                  ? `Approve Redraft ${proposalRedrafts.current}`
                  : 'Approve Spec change'
              }
              approveAction={approveProposal.bind(
                null,
                proposal.id,
                request.id,
                proposalRedrafts?.current ?? null,
              )}
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
