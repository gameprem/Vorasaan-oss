'use client';

import type { DelegationView } from '@vorasaan/shared';
import { useActionState, useEffect, useState } from 'react';
import { type DelegationActionState, deleteDelegation } from '@/lib/delegation-actions';
import { ROLE_LABEL, secondaryButton } from './ui';

const FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/** A date in the viewer's own time zone (UTC until the browser takes over, to hydrate cleanly). */
export function LocalDate({ iso }: { iso: string }) {
  const [text, setText] = useState(
    () => `${new Date(iso).toLocaleString('en-GB', { ...FORMAT, timeZone: 'UTC' })} UTC`,
  );
  useEffect(() => setText(new Date(iso).toLocaleString('en-GB', FORMAT)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

function DeleteButton({ delegation, label }: { delegation: DelegationView; label: string }) {
  const [state, run, pending] = useActionState<DelegationActionState>(
    deleteDelegation.bind(null, delegation.teamId, delegation.id),
    {},
  );
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (!window.confirm(`Delete this Delegation (${label})?`)) e.preventDefault();
      }}
    >
      <button
        type="submit"
        disabled={pending}
        aria-label={`Delete Delegation: ${label}`}
        className={`${secondaryButton} text-sm text-seal`}
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {state.error && (
        <p role="alert" className="mt-1 text-sm text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}

/**
 * Current and upcoming Delegations. `teamNames` labels each row with its Team (for lists
 * across Teams); Delete shows only where the API says the viewer may (`canDelete`).
 */
export function DelegationList({
  delegations,
  teamNames,
  empty,
}: {
  delegations: DelegationView[];
  teamNames?: Record<string, string>;
  empty: string;
}) {
  if (delegations.length === 0) return <p className="text-ink-soft">{empty}</p>;
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {delegations.map((d) => {
        const role = ROLE_LABEL[d.role];
        const team = teamNames?.[d.teamId];
        const label = `${d.delegator.name} to ${d.delegate.name}, ${role}${team ? ` in ${team}` : ''}`;
        return (
          <li key={d.id} className="flex flex-wrap items-start gap-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {d.delegator.name} → {d.delegate.name}{' '}
                <span className="font-normal text-ink-soft">
                  ({role}
                  {team ? `, ${team}` : ''})
                </span>
              </span>
              <span className="block text-sm text-ink-soft">
                <LocalDate iso={d.startsAt} /> – <LocalDate iso={d.endsAt} />
                {d.createdBy.id !== d.delegator.id && ` · set by ${d.createdBy.name}`}
              </span>
            </span>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-sm ${
                d.active ? 'border-jade/40 bg-jade-wash text-jade' : 'border-rule text-ink-soft'
              }`}
            >
              {d.active ? 'Active' : 'Upcoming'}
            </span>
            {d.canDelete && <DeleteButton delegation={d} label={label} />}
          </li>
        );
      })}
    </ul>
  );
}
