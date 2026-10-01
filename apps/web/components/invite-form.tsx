'use client';

import { useActionState } from 'react';
import { type InviteState, invite } from '@/lib/org-actions';
import { field, primaryButton } from './ui';

export function InviteForm({ origin }: { origin: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(invite, {});
  const link = state.created ? `${origin}/invite/${state.created.token}` : undefined;
  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">
          <span className="text-sm">Email</span>
          <input name="email" type="email" required placeholder="beam@acme.com" className={field} />
        </label>
        <label className="w-36">
          <span className="text-sm">Access</span>
          <select name="role" defaultValue="MEMBER" className={field}>
            <option value="MEMBER">Member</option>
            <option value="ADMIN">Admin</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Creating link…' : 'Create invite link'}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="mt-3 text-lacquer">
          {state.error}
        </p>
      )}
      {link && (
        <div className="mt-5 rounded-card bg-jade-wash p-4">
          <p className="font-medium text-jade">
            Send this link to {state.created?.email}. It works once and expires in 7 days.
          </p>
          <input
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 w-full rounded-tile bg-surface ring-1 ring-inset ring-line px-3 py-2 font-mono text-sm text-fg"
          />
        </div>
      )}
    </div>
  );
}
