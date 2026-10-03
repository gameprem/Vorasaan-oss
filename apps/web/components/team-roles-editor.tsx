'use client';

import { type OrgMemberView, TeamRole, type TeamView } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { setTeamRoles } from '@/lib/org-actions';
import { ROLE_LABEL, secondaryButton } from './ui';
import { Checkbox } from './ui/checkbox';
import { PersonPicker } from './ui/person-picker';

/** One row per member with a checkbox per Team Role; plus "add someone to this Team". */
export function TeamRolesEditor({
  team,
  orgMembers,
}: {
  team: TeamView;
  orgMembers: OrgMemberView[];
}) {
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState('');
  const inTeam = new Set(team.members.map((m) => m.userId));
  const candidates = orgMembers.filter((m) => !inTeam.has(m.userId));

  const save = (userId: string, roles: TeamRole[]) =>
    start(async () => {
      setError(undefined);
      const result = await setTeamRoles(team.id, userId, roles);
      if (result.error) setError(result.error);
    });

  return (
    <div>
      <div className="overflow-x-auto rounded-card bg-rail">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-bg text-left text-fg-soft">
              <th className="px-4 py-2 font-normal">Member</th>
              {TeamRole.options.map((role) => (
                <th key={role} className="px-2 py-2 text-center font-normal">
                  {ROLE_LABEL[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.members.map((m) => (
              <tr key={m.userId} className="border-b-2 border-bg last:border-0">
                <td className="px-4 py-2">
                  <span className="block font-medium">{m.name}</span>
                  <span className="block text-fg-soft">{m.email}</span>
                </td>
                {TeamRole.options.map((role) => {
                  const has = m.roles.includes(role);
                  return (
                    <td key={role} className="px-2 py-2 text-center">
                      <Checkbox
                        aria-label={`${m.name} is ${ROLE_LABEL[role]}`}
                        className="justify-center"
                        isSelected={has}
                        isDisabled={pending}
                        onChange={() =>
                          save(
                            m.userId,
                            has ? m.roles.filter((r) => r !== role) : [...m.roles, role],
                          )
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm text-fg-soft">
        Unticking every role removes the person from the Team.
      </p>

      {candidates.length > 0 && (
        <form
          className="mt-6 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding) save(adding, ['BACKEND']);
            setAdding('');
          }}
        >
          <PersonPicker
            label="Add someone from your organization"
            className="min-w-56 flex-1"
            placeholder="Choose a person"
            people={candidates.map((c) => ({ id: c.userId, name: c.name, email: c.email }))}
            value={adding}
            onChange={setAdding}
          />
          <button type="submit" disabled={!adding || pending} className={secondaryButton}>
            Add as Backend
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-lacquer">
          {error}
        </p>
      )}
    </div>
  );
}
