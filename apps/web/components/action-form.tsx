'use client';

import { type ReactNode, useActionState, useEffect, useRef } from 'react';
import type { FormState } from '@/lib/org-actions';
import { primaryButton, secondaryButton } from './ui';

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

/** One button bound to a server action (no fields), with an optional confirmation and its error. */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirmText,
  className = secondaryButton,
}: {
  action: (prev: FormState) => Promise<FormState>;
  label: string;
  pendingLabel: string;
  /** Asked with window.confirm before running. */
  confirmText?: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState<FormState>(action, {});
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <button type="submit" disabled={pending} className={className}>
        {pending ? pendingLabel : label}
      </button>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}
