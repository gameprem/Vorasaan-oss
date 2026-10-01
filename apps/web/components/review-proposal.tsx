'use client';

import { useActionState } from 'react';

type ReviewState = { error?: string };

/**
 * Approve and Reject for a pending Spec Proposal or Brief Proposal. The actions are server
 * actions bound to the proposal; the API checks that the viewer is its approver.
 */
export function ReviewProposal({
  approveAction,
  rejectAction,
  approveLabel = 'Approve Spec change',
  note,
}: {
  approveAction: (prev: ReviewState) => Promise<ReviewState>;
  rejectAction: (prev: ReviewState) => Promise<ReviewState>;
  approveLabel?: string;
  /** What rejecting means, under the buttons. */
  note: string;
}) {
  const [approveState, approve, approving] = useActionState<ReviewState>(approveAction, {});
  const [rejectState, reject, rejecting] = useActionState<ReviewState>(rejectAction, {});
  const busy = approving || rejecting;
  const error = approveState.error ?? rejectState.error;

  return (
    <div className="mt-6">
      {error && (
        <p role="alert" className="mb-4 text-lacquer">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <form action={approve}>
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-jade px-5 py-2.5 font-semibold text-on-ink hover:opacity-90 disabled:opacity-40"
          >
            {approving ? 'Approving…' : approveLabel}
          </button>
        </form>
        <form action={reject}>
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-surface px-5 py-2.5 font-semibold text-fg hover:bg-surface-hi disabled:opacity-40"
          >
            {rejecting ? 'Rejecting…' : 'Reject'}
          </button>
        </form>
      </div>
      <p className="mt-3 text-sm text-fg-soft">{note}</p>
    </div>
  );
}
