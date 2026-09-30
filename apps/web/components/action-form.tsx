'use client';

import { type ReactNode, useActionState, useEffect, useRef } from 'react';
import type { FormState } from '@/lib/org-actions';
import { primaryButton } from './ui';

/** A small form bound to a server action: shows its error and resets on success. */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  className = 'flex flex-wrap items-end gap-3',
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  pendingLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={run}>
      <div className={className}>
        {children}
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}
