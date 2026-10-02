'use client';

import type { TeamRole, TeamView } from '@vorasaan/shared';
import { useActionState, useEffect, useId, useState } from 'react';
import { createDelegation, type DelegationActionState } from '@/lib/delegation-actions';
import { field, primaryButton, ROLE_LABEL } from './ui';

export type DelegationTeam = Pick<TeamView, 'id' | 'name' | 'members'> & { projectName: string };

/** `<input type="datetime-local">` value → ISO, read in the browser's own time zone. */
function toIso(local: string) {
  const date = new Date(local);
  return local && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

/** Now, rounded up to the next quarter hour, as a local `datetime-local` value. */
function localNow() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Names a Delegate for a Team Role in a Team. The Delegate picker lists only the other
 * people holding that Team Role in that Team. With `forAnyone` (an Admin on a Team page)
 * the delegator can be any member; otherwise it is the signed-in person (`meId`).
 */
export function DelegationForm({
  teams,
  meId,
  forAnyone = false,
}: {
  teams: DelegationTeam[];
  meId: string;
  forAnyone?: boolean;
}) {
  const [state, run, pending] = useActionState<DelegationActionState, FormData>(
    createDelegation,
    {},
  );
  const id = useId();
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const team = teams.find((t) => t.id === teamId);
  const [delegatorId, setDelegatorId] = useState(forAnyone ? '' : meId);
  const delegator = team?.members.find((m) => m.userId === delegatorId);
  const roles = delegator?.roles ?? [];
  const [role, setRole] = useState<TeamRole | ''>('');
  const effectiveRole = role && roles.includes(role) ? role : roles.length === 1 ? roles[0] : '';
  const delegates =
    team?.members.filter(
      (m) => m.userId !== delegatorId && effectiveRole && m.roles.includes(effectiveRole),
    ) ?? [];
  const [delegateId, setDelegateId] = useState('');
  const effectiveDelegate = delegates.some((m) => m.userId === delegateId) ? delegateId : '';
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  useEffect(() => {
    setStartsAt((s) => s || localNow());
  }, []);
  useEffect(() => {
    if (!state.ok) return;
    setDelegateId('');
    setEndsAt('');
    setStartsAt(localNow());
  }, [state]);

  if (teams.length === 0) return null;
  const noRole = delegatorId !== '' && roles.length === 0;

  return (
    <form action={run} className="space-y-4" aria-describedby={`${id}-hint`}>
      <p id={`${id}-hint`} className="text-sm text-fg-soft">
        Dates are in your local time. The Delegate must hold the same Team Role in that Team.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {teams.length > 1 ? (
          <div>
            <label htmlFor={`${id}-team`} className="block text-sm">
              Team
            </label>
            <select
              id={`${id}-team`}
              name="teamId"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className={field}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.projectName} / {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="teamId" value={teamId} />
        )}
        {forAnyone ? (
          <div>
            <label htmlFor={`${id}-delegator`} className="block text-sm">
              On leave (delegator)
            </label>
            <select
              id={`${id}-delegator`}
              name="delegatorId"
              value={delegatorId}
              onChange={(e) => setDelegatorId(e.target.value)}
              required
              className={field}
            >
              <option value="">Pick a member…</option>
              {team?.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                  {m.userId === meId ? ' (you)' : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor={`${id}-role`} className="block text-sm">
            Team Role
          </label>
          <select
            id={`${id}-role`}
            name="role"
            value={effectiveRole}
            onChange={(e) => setRole(e.target.value as TeamRole)}
            required
            disabled={roles.length === 0}
            className={field}
          >
            <option value="">{roles.length === 0 ? '—' : 'Pick a Team Role…'}</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-delegate`} className="block text-sm">
            Delegate
          </label>
          <select
            id={`${id}-delegate`}
            name="delegateId"
            value={effectiveDelegate}
            onChange={(e) => setDelegateId(e.target.value)}
            required
            disabled={delegates.length === 0}
            className={field}
          >
            <option value="">
              {!effectiveRole
                ? 'Pick a Team Role first'
                : delegates.length === 0
                  ? 'Nobody else holds this Team Role'
                  : 'Pick a Delegate…'}
            </option>
            {delegates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-starts`} className="block text-sm">
            Starts
          </label>
          <input
            id={`${id}-starts`}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            required
            className={field}
          />
        </div>
        <div>
          <label htmlFor={`${id}-ends`} className="block text-sm">
            Ends
          </label>
          <input
            id={`${id}-ends`}
            type="datetime-local"
            value={endsAt}
            min={startsAt || undefined}
            onChange={(e) => setEndsAt(e.target.value)}
            required
            className={field}
          />
        </div>
      </div>
      <input type="hidden" name="startsAt" value={toIso(startsAt)} />
      <input type="hidden" name="endsAt" value={toIso(endsAt)} />
      {noRole && (
        <p className="text-sm text-fg-soft">
          {forAnyone ? 'This member has' : 'You have'} no Team Role in this Team to delegate.
        </p>
      )}
      <button type="submit" disabled={pending || noRole} className={primaryButton}>
        {pending ? 'Saving…' : 'Name Delegate'}
      </button>
      {state.error && (
        <p role="alert" className="text-lacquer">
          {state.error}
        </p>
      )}
      {state.ok && !pending && (
        <p role="status" className="text-jade">
          Delegation saved.
        </p>
      )}
    </form>
  );
}
