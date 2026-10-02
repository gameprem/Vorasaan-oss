'use client';

import type { RoleOwnerView, TeamRole, TeamView } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { setRoleOwners } from '@/lib/org-actions';
import { primaryButton, ROLE_LABEL } from './ui';

/**
 * For each Team Role someone in the Team holds, tick who owns it on this Feature.
 * Decision Requests route to these Role Owners.
 */
export function RoleOwnersEditor({
  featureId,
  team,
  owners,
}: {
  featureId: string;
  team: TeamView;
  owners: RoleOwnerView[];
}) {
  const [selected, setSelected] = useState(
    () => new Set(owners.map((o) => `${o.userId}:${o.role}`)),
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, start] = useTransition();

  const roles = [...new Set(team.members.flatMap((m) => m.roles))] as TeamRole[];
  if (roles.length === 0) {
    return (
      <p className="text-fg-soft">
        Give people Team Roles on the Team page first, then choose who owns each role here.
      </p>
    );
  }

  // Updater functions must stay pure: React may re-run them during render.
  const toggle = (key: string) => {
    setMessage(undefined);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="space-y-6">
        {roles.map((role) => (
          <fieldset key={role}>
            <legend className="font-medium">{ROLE_LABEL[role]}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {team.members
                .filter((m) => m.roles.includes(role))
                .map((m) => {
                  const key = `${m.userId}:${role}`;
                  const on = selected.has(key);
                  return (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-full px-3 py-1 ${
                        on
                          ? 'bg-jade-wash text-jade'
                          : 'bg-surface text-fg-soft hover:bg-surface-hi'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(key)}
                        className="accent-jade"
                      />
                      {m.name}
                    </label>
                  );
                })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          disabled={pending}
          className={primaryButton}
          onClick={() =>
            start(async () => {
              const result = await setRoleOwners(featureId, {
                owners: [...selected].map((key) => {
                  const [userId, role] = key.split(':') as [string, TeamRole];
                  return { userId, role };
                }),
              });
              setMessage(
                result.error ? { ok: false, text: result.error } : { ok: true, text: 'Saved.' },
              );
            })
          }
        >
          {pending ? 'Saving…' : 'Save Role Owners'}
        </button>
        {message && (
          <p role="status" className={message.ok ? 'text-jade' : 'text-lacquer'}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
