'use client';

import type { PersonRef, RequestMessageKind } from '@vorasaan/shared';
import { useActionState, useEffect, useRef, useState } from 'react';
import {
  claimRequest,
  postRequestMessage,
  type RequestActionState,
  reassignRequest,
  withdrawRequest,
} from '@/lib/request-actions';
import { field, primaryButton, secondaryButton } from './ui';
import { PersonPicker } from './ui/person-picker';

function ErrorText({ state }: { state: RequestActionState }) {
  return state.error ? (
    <p role="alert" className="mt-2 text-lacquer">
      {state.error}
    </p>
  ) : null;
}

/** Become the Decider of a request sent to several people, or routed to someone else. */
export function ClaimButton({ requestId }: { requestId: string }) {
  const [state, run, pending] = useActionState<RequestActionState>(
    claimRequest.bind(null, requestId),
    {},
  );
  return (
    <form action={run}>
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? 'Claiming…' : 'Claim it'}
      </button>
      <ErrorText state={state} />
    </form>
  );
}

/** The Raiser withdraws the request. Asks for confirmation first. */
export function WithdrawButton({ requestId, draft }: { requestId: string; draft?: boolean }) {
  const [state, run, pending] = useActionState<RequestActionState>(
    withdrawRequest.bind(null, requestId),
    {},
  );
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={secondaryButton}>
        {draft ? 'Discard draft' : 'Withdraw'}
      </button>
    );
  }
  return (
    <form action={run} className="rounded-card bg-rail p-4">
      <p>
        {draft
          ? 'Discard this draft? Nobody has seen it yet.'
          : 'Withdraw this request? Whoever it was sent to stops seeing it in their Inbox.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          ref={confirmRef}
          type="submit"
          disabled={pending}
          className="rounded-full bg-lacquer px-4 py-2 font-semibold text-on-ink hover:opacity-90 disabled:opacity-40"
        >
          {pending ? 'Withdrawing…' : draft ? 'Yes, discard it' : 'Yes, withdraw it'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className={secondaryButton}
        >
          Keep it
        </button>
      </div>
      <ErrorText state={state} />
    </form>
  );
}

/** The Decider hands the request to someone else holding the decider role in the Team. */
export function ReassignForm({
  requestId,
  candidates,
  roleLabel,
}: {
  requestId: string;
  candidates: PersonRef[];
  roleLabel: string;
}) {
  const [state, run, pending] = useActionState<RequestActionState, FormData>(
    reassignRequest.bind(null, requestId),
    {},
  );
  if (candidates.length === 0) {
    return (
      <p className="text-fg-soft">
        Nobody else in the Team holds the {roleLabel} role, so there is no one to reassign to.
      </p>
    );
  }
  return (
    <form action={run}>
      <div className="flex flex-wrap items-end gap-3">
        <PersonPicker
          label="New Decider"
          name="userId"
          className="min-w-56"
          placeholder={`Choose a ${roleLabel}`}
          people={candidates.map((p) => ({ id: p.id, name: p.name }))}
          isRequired
        />
        <button type="submit" disabled={pending} className={secondaryButton}>
          {pending ? 'Reassigning…' : 'Reassign'}
        </button>
      </div>
      <ErrorText state={state} />
    </form>
  );
}

const MESSAGE_COPY: Record<
  RequestMessageKind,
  { label: string; placeholder: string; submit: string; pending: string }
> = {
  QUESTION: {
    label: 'Ask the Raiser for more info',
    placeholder: 'What do you need to know before deciding?',
    submit: 'Ask for more info',
    pending: 'Sending…',
  },
  ANSWER: {
    label: 'Your answer',
    placeholder: 'Answer the question so the Decider can decide.',
    submit: 'Send answer',
    pending: 'Sending…',
  },
  NOTE: {
    label: 'Add a note',
    placeholder: 'Extra context for the thread. It does not change the status.',
    submit: 'Add note',
    pending: 'Adding…',
  },
};

/** One box in the thread: the Decider's question, the Raiser's answer, or a note. */
export function MessageForm({ requestId, kind }: { requestId: string; kind: RequestMessageKind }) {
  const [state, run, pending] = useActionState<RequestActionState, FormData>(
    postRequestMessage.bind(null, requestId, kind),
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  const copy = MESSAGE_COPY[kind];
  const id = `message-${kind.toLowerCase()}`;
  return (
    <form ref={form} action={run} className="max-w-[72ch]">
      <label htmlFor={id} className="block text-sm font-medium">
        {copy.label}
      </label>
      <textarea
        id={id}
        name="body"
        required
        rows={3}
        placeholder={copy.placeholder}
        className={field}
      />
      <button
        type="submit"
        disabled={pending}
        className={`mt-3 ${kind === 'NOTE' ? secondaryButton : primaryButton}`}
      >
        {pending ? copy.pending : copy.submit}
      </button>
      <ErrorText state={state} />
    </form>
  );
}
