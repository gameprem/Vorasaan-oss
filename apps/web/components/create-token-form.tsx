'use client';

import { useActionState } from 'react';
import { createAccessToken, type TokenState } from '@/lib/auth-actions';
import { inputClass } from './login-form';

/** `activeIds` hides the one-time token box once that token is revoked. */
export function CreateTokenForm({ activeIds }: { activeIds: string[] }) {
  const [state, action, pending] = useActionState<TokenState, FormData>(createAccessToken, {});
  return (
    <div className="mt-8">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="min-w-60 flex-1">
          <span className="text-sm">Token name</span>
          <input name="name" placeholder="Laptop CLI" required className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-5 py-2.5 font-semibold text-on-ink hover:opacity-90 disabled:opacity-40"
        >
          {pending ? 'Creating…' : 'Create token'}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="mt-3 text-lacquer">
          {state.error}
        </p>
      )}
      {state.created && activeIds.includes(state.created.id) && (
        <div className="mt-6 rounded-card bg-jade-wash p-4">
          <p className="font-medium text-jade">
            Copy “{state.created.name}” now. You won't see it again.
          </p>
          <input
            readOnly
            value={state.created.token}
            aria-label="New access token"
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 w-full rounded-tile bg-surface ring-1 ring-inset ring-line px-3 py-2 font-mono text-sm text-fg"
          />
        </div>
      )}
    </div>
  );
}
