'use client';

import { useActionState } from 'react';
import { type LoginState, login } from '@/lib/auth-actions';

export const inputClass =
  'mt-1 w-full rounded-lg border border-rule bg-sheet px-3 py-2 text-ink placeholder:text-ink-soft/60';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="mt-8 space-y-4">
      <label className="block">
        <span className="text-sm">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.email}
          className={inputClass}
        />
      </label>
      <label className="block">
        <span className="text-sm">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </label>
      {state.error && (
        <p role="alert" className="text-seal">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-ink px-5 py-2.5 font-medium text-sheet disabled:opacity-40"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
