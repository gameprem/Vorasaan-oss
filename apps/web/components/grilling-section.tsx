import type {
  BriefProposalView,
  GrillingRoundView,
  GrillingSkipReason,
  GrillingView,
} from '@vorasaan/shared';
import Link from 'next/link';
import {
  answerGrillingQuestion,
  approveBriefProposal,
  cancelGrilling,
  rejectBriefProposal,
  skipGrillingRound,
  startGrilling,
} from '@/lib/project-actions';
import { ActionButton, ActionForm } from './action-form';
import { relativeTime } from './bits';
import { ReviewProposal } from './review-proposal';
import { SpecDiff } from './spec-diff';
import { field, primaryButton, ROLE_LABEL, ROUND_LABEL } from './ui';

const SKIP_TEXT: Record<GrillingSkipReason, (role: string) => string> = {
  NO_ONE_WITH_ROLE: (role) => `Skipped: nobody in the Project’s Teams holds the ${role} Team Role`,
  NOTHING_TO_ASK: () => 'Skipped: the known material already answers it',
  BY_STARTER: () => 'Skipped by the person who started the Grilling or an Admin',
};

function roundStatus(g: GrillingView, r: GrillingRoundView) {
  const role = ROLE_LABEL[r.role];
  if (r.status === 'SKIPPED') return r.skipReason ? SKIP_TEXT[r.skipReason](role) : 'Skipped';
  if (r.status === 'ANSWERED') return 'Answered';
  if (r.status === 'ASKING') {
    return g.status === 'RUNNING' ? `Asking the ${role}s now` : 'Stopped when cancelled';
  }
  return g.status === 'RUNNING' ? 'Not reached yet' : 'Not asked';
}

const STATUS_TEXT: Record<GrillingView['status'], string> = {
  RUNNING: 'Running',
  DRAFTED: 'Brief Proposal drafted',
  CANCELLED: 'Cancelled',
};

/**
 * The Project's latest Grilling: its rounds (business, UX, technical), the current round's
 * questions with an answer box for the people holding its Team Role, skip and cancel for the
 * person who started it or an Admin, and any pending Brief Proposal to approve.
 */
export function GrillingSection({
  projectId,
  grillings,
  proposals,
  meId,
  canEdit,
}: {
  projectId: string;
  grillings: GrillingView[];
  proposals: BriefProposalView[];
  meId: string | null;
  /** Admins and the Project's POs start a Grilling (the API checks it). */
  canEdit: boolean;
}) {
  const g = grillings[0];
  const pending = proposals.filter((p) => p.status === 'PENDING');
  const blocksStart =
    g && (g.status === 'RUNNING' || (g.status === 'DRAFTED' && g.proposal?.status === 'PENDING'));

  return (
    <div className="max-w-4xl">
      <p className="text-fg-soft">
        The AI asks the people in this Project what it can’t learn from the Brief, the Attachments
        and the Features: business questions for POs, then UX for Designers, then technical for Tech
        Leads. It turns the answers into a Brief Proposal that the person who started it approves.
      </p>

      {pending.map((p) => (
        <BriefProposalReview key={p.id} projectId={projectId} proposal={p} meId={meId} />
      ))}

      {!g ? (
        <p className="mt-8 text-fg-soft">
          No Grilling yet.
          {canEdit ? '' : ' The Project’s POs or an Admin start one.'}
        </p>
      ) : (
        <section aria-labelledby="grilling-heading" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="grilling-heading" className="text-lg font-semibold">
              {g.status === 'RUNNING' ? 'Current Grilling' : 'Latest Grilling'}:{' '}
              {STATUS_TEXT[g.status]}
            </h2>
            <p className="text-sm text-fg-soft">
              Started by {g.startedBy.name} {relativeTime(g.createdAt)}
            </p>
          </div>
          {g.status === 'DRAFTED' && g.proposal && (
            <p className="mt-1 text-sm">
              {g.proposal.status === 'APPROVED' && g.proposal.resultVersion
                ? `Approved: it became Brief v${g.proposal.resultVersion}.`
                : g.proposal.status === 'REJECTED'
                  ? 'Its Brief Proposal was rejected.'
                  : 'Its Brief Proposal is waiting for approval (above).'}
            </p>
          )}

          <ol className="mt-4 grid gap-3 sm:grid-cols-3" aria-label="Rounds">
            {g.rounds.map((r) => {
              const current = g.status === 'RUNNING' && g.currentRound === r.kind;
              return (
                <li
                  key={r.kind}
                  aria-current={current ? 'step' : undefined}
                  className={`rounded-card p-4 ${current ? 'bg-ink-wash text-fg' : 'bg-rail'}`}
                >
                  <p className="font-medium">
                    {ROUND_LABEL[r.kind]}{' '}
                    <span className="text-fg-soft">· {ROLE_LABEL[r.role]}</span>
                  </p>
                  <p className="mt-1 text-sm text-fg-soft">{roundStatus(g, r)}</p>
                </li>
              );
            })}
          </ol>

          {g.rounds.map((r) =>
            g.status === 'RUNNING' && g.currentRound === r.kind ? (
              <CurrentRound key={r.kind} projectId={projectId} grilling={g} round={r} />
            ) : r.questions.some((q) => q.answer) ? (
              <details key={r.kind} className="mt-6">
                <summary className="cursor-pointer font-medium">
                  {ROUND_LABEL[r.kind]} round: questions and answers
                </summary>
                <QuestionList round={r} />
              </details>
            ) : null,
          )}

          {g.canManage && blocksStart && (
            <div className="mt-8 flex flex-wrap gap-3">
              {g.status === 'RUNNING' && g.currentRound && (
                <ActionButton
                  action={skipGrillingRound.bind(null, projectId, g.id, g.currentRound)}
                  label={`Skip the ${ROUND_LABEL[g.currentRound]} round`}
                  pendingLabel="Skipping… (the AI prepares the next round)"
                  confirmText={`Skip the ${ROUND_LABEL[g.currentRound]} round? Answers given so far still count.`}
                />
              )}
              <ActionButton
                action={cancelGrilling.bind(null, projectId, g.id)}
                label="Cancel the Grilling"
                pendingLabel="Cancelling…"
                confirmText="Cancel this Grilling? No Brief Version comes of it."
              />
            </div>
          )}
        </section>
      )}

      {canEdit && !blocksStart && (
        <div className="mt-8 rounded-card bg-rail p-5">
          <p className="font-medium">{g ? 'Start a new Grilling' : 'Start a Grilling'}</p>
          <p className="mt-1 text-sm text-fg-soft">
            The AI reads what the Project already has and asks only about the gaps. Rounds with
            nobody holding their Team Role are skipped.
          </p>
          <div className="mt-4">
            <ActionButton
              action={startGrilling.bind(null, projectId)}
              label="Start Grilling"
              pendingLabel="Starting… (the AI prepares the questions)"
              className={primaryButton}
            />
          </div>
        </div>
      )}

      {grillings.length > 1 && (
        <p className="mt-6 text-sm text-fg-soft">
          {grillings.length - 1} earlier Grilling{grillings.length === 2 ? '' : 's'}. Approved ones
          are in the Brief’s{' '}
          <Link
            href={`/projects/${projectId}?tab=history`}
            className="underline underline-offset-2"
          >
            History
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function QuestionList({ round }: { round: GrillingRoundView }) {
  return (
    <ol className="mt-3 rows">
      {round.questions.map((q) => (
        <li key={q.id} className="py-3">
          <p className="font-medium">{q.text}</p>
          {q.answer ? (
            <>
              <p className="mt-1 whitespace-pre-wrap">{q.answer}</p>
              {q.answeredBy && (
                <p className="mt-1 text-sm text-fg-soft">
                  {q.answeredBy.name}
                  {q.answeredAt && `, ${relativeTime(q.answeredAt)}`}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-fg-soft">
              {q.skipped ? 'Not answered (round skipped)' : 'Not answered'}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function CurrentRound({
  projectId,
  grilling: g,
  round,
}: {
  projectId: string;
  grilling: GrillingView;
  round: GrillingRoundView;
}) {
  const role = ROLE_LABEL[round.role];
  const open = round.questions.filter((q) => !q.answer).length;
  return (
    <section id="current-round" aria-labelledby="current-round-heading" className="mt-8">
      <h3 id="current-round-heading" className="text-lg font-semibold">
        {ROUND_LABEL[round.kind]} round: questions for {role}s
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        {g.canAnswer
          ? `Any ${role} in the Project answers each question once. ${open} left; the round ends when all are answered.`
          : `Waiting for a ${role} in one of the Project’s Teams to answer (${open} left).`}
      </p>
      <ol className="mt-4 space-y-5">
        {round.questions.map((q, i) => (
          <li key={q.id} className="rounded-card bg-rail p-4">
            <p className="font-medium">
              {i + 1}. {q.text}
            </p>
            {q.answer ? (
              <>
                <p className="mt-2 whitespace-pre-wrap">{q.answer}</p>
                <p className="mt-1 text-sm text-fg-soft">
                  Answered by {q.answeredBy?.name ?? 'someone'}
                  {q.answeredAt && ` ${relativeTime(q.answeredAt)}`}
                </p>
              </>
            ) : g.canAnswer ? (
              <div className="mt-3">
                <ActionForm
                  action={answerGrillingQuestion.bind(null, projectId, g.id, q.id)}
                  submitLabel="Answer"
                  pendingLabel={open === 1 ? 'Saving… (the AI moves to the next round)' : 'Saving…'}
                  className="flex flex-col items-start gap-3"
                >
                  <label className="block w-full">
                    <span className="sr-only">Your answer to question {i + 1}</span>
                    <textarea
                      name="answer"
                      required
                      rows={3}
                      maxLength={10_000}
                      className={field}
                    />
                  </label>
                </ActionForm>
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-soft">Not answered yet.</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function BriefProposalReview({
  projectId,
  proposal,
  meId,
}: {
  projectId: string;
  proposal: BriefProposalView;
  meId: string | null;
}) {
  return (
    <section
      id="brief-proposal"
      aria-labelledby={`proposal-${proposal.id}`}
      className="mt-8 rounded-card bg-ink-wash p-5"
    >
      <h2 id={`proposal-${proposal.id}`} className="text-lg font-semibold">
        Proposed Project Brief change
      </h2>
      <p className="mt-1 text-sm text-fg-soft">
        {proposal.source === 'GRILLING' ? 'Drafted by AI from the Grilling answers' : 'Proposed'}{' '}
        {proposal.baseVersion ? `against Brief v${proposal.baseVersion}` : 'as the first Brief'},{' '}
        {relativeTime(proposal.createdAt)}. {proposal.approver.name} approves it.
      </p>
      {proposal.summary && <p className="mt-2">{proposal.summary}</p>}
      <div className="mt-4">
        <SpecDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} />
      </div>
      {meId === proposal.approver.id ? (
        <ReviewProposal
          approveAction={approveBriefProposal.bind(null, projectId, proposal.id)}
          rejectAction={rejectBriefProposal.bind(null, projectId, proposal.id)}
          approveLabel="Approve Brief change"
          note="Rejecting leaves the Project Brief as it is."
        />
      ) : (
        <p className="mt-4 text-fg-soft">Waiting for {proposal.approver.name} to review it.</p>
      )}
    </section>
  );
}
