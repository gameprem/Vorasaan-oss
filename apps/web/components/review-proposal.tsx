'use client';

import { useActionState } from 'react';
import { type ActionState, approveProposal, rejectProposal } from '@/lib/actions';

export function ReviewProposal({
  proposalId,
  requestId,
}: {
  proposalId: string;
  requestId: string;
}) {
  const [approveState, approve, approving] = useActionState<ActionState>(
    approveProposal.bind(null, proposalId, requestId),
    {},
  );
  const [rejectState, reject, rejecting] = useActionState<ActionState>(
    rejectProposal.bind(null, proposalId, requestId),
    {},
  );
  const busy = approving || rejecting;
  const error = approveState.error ?? rejectState.error;

  return (
    <div className="mt-6">
      {error && (
        <p role="alert" className="mb-4 text-seal">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <form action={approve}>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-jade px-5 py-2.5 font-medium text-sheet disabled:opacity-40"
          >
            {approving ? 'Approving…' : 'Approve Spec change'}
          </button>
        </form>
        <form action={reject}>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg border border-rule bg-sheet px-5 py-2.5 font-medium text-ink disabled:opacity-40"
          >
            {rejecting ? 'Rejecting…' : 'Reject'}
          </button>
        </form>
      </div>
      <p className="mt-3 text-sm text-ink-soft">
        Rejecting keeps your Decision. Only the Spec stays as it is.
      </p>
    </div>
  );
}
