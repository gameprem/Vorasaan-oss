'use client';

import type { TeamRole, TeamView } from '@vorasaan/shared';
import { useActionState, useEffect, useId, useState } from 'react';
import { createDelegation, type DelegationActionState } from '@/lib/delegation-actions';
import { primaryButton, ROLE_LABEL } from './ui';
import { DatePicker } from './ui/date-picker';
import { PersonPicker } from './ui/person-picker';
import { Select } from './ui/select';

export type DelegationTeam = Pick<TeamView, 'id' | 'name' | 'members'> & { projectName: string };

/** A '2026-10-03T09:30' picker value → ISO, read in the browser's own time zone. */
function toIso(local: string) {
  const date = new Date(local);
  return local && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

/** Now, rounded up to the next quarter hour, as a local '2026-10-03T09:30' value. */
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
          <Select
            label="Team"
            name="teamId"
            options={teams.map((t) => ({ id: t.id, label: `${t.projectName} / ${t.name}` }))}
            value={teamId}
            onChange={setTeamId}
          />
        ) : (
          <input type="hidden" name="teamId" value={teamId} />
        )}
        {forAnyone ? (
          <PersonPicker
            label="On leave (delegator)"
            name="delegatorId"
            placeholder="Pick a member…"
            people={(team?.members ?? []).map((m) => ({
              id: m.userId,
              name: m.name,
              roles: m.roles,
              note: m.userId === meId ? '(you)' : undefined,
            }))}
            value={delegatorId}
            onChange={setDelegatorId}
            isRequired
          />
        ) : null}
        <Select
          label="Team Role"
          name="role"
          placeholder={roles.length === 0 ? '—' : 'Pick a Team Role…'}
          options={roles.map((r) => ({ id: r, label: ROLE_LABEL[r] }))}
          value={effectiveRole}
          onChange={(r) => setRole(r as TeamRole)}
          isRequired
          isDisabled={roles.length === 0}
        />
        <PersonPicker
          label="Delegate"
          name="delegateId"
          placeholder={
            !effectiveRole
              ? 'Pick a Team Role first'
              : delegates.length === 0
                ? 'Nobody else holds this Team Role'
                : 'Pick a Delegate…'
          }
          people={delegates.map((m) => ({ id: m.userId, name: m.name, roles: m.roles }))}
          value={effectiveDelegate}
          onChange={setDelegateId}
          isRequired
          isDisabled={delegates.length === 0}
        />
        <DatePicker
          label="Starts"
          granularity="minute"
          value={startsAt}
          onChange={setStartsAt}
          isRequired
        />
        <DatePicker
          label="Ends"
          granularity="minute"
          value={endsAt}
          minValue={startsAt || undefined}
          onChange={setEndsAt}
          isRequired
        />
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
