'use client';

import { useActionState } from 'react';
import { secondaryButton } from './ui';

type RevertState = { error?: string; stale?: boolean };

/**
 * Restores an earlier version (of a Spec or a Project Brief) as a new one, on top of the latest
 * (`baseVersion`). `action` is the server action bound to the version to restore.
 */
export function RevertButton({
  action,
  version,
  baseVersion,
}: {
  action: (prev: RevertState) => Promise<RevertState>;
  version: number;
  baseVersion: number;
}) {
  const [state, run, pending] = useActionState<RevertState>(action, {});
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (!window.confirm(`Restore v${version} as v${baseVersion + 1}?`)) e.preventDefault();
      }}
    >
      <button type="submit" disabled={pending} className={`${secondaryButton} text-sm`}>
        {pending ? 'Reverting…' : `Revert to v${version}`}
      </button>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-seal">
          {state.error}
          {state.stale && ' Reload the page to see the latest version.'}
        </p>
      )}
    </form>
  );
}
