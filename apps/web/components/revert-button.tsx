'use client';

import { useActionState } from 'react';
import { type FeatureActionState, revertSpec } from '@/lib/feature-actions';
import { secondaryButton } from './ui';

/** Restores an earlier Spec Version as a new one, on top of the latest (`baseVersion`). */
export function RevertButton({
  featureId,
  version,
  baseVersion,
}: {
  featureId: string;
  version: number;
  baseVersion: number;
}) {
  const [state, run, pending] = useActionState<FeatureActionState>(
    revertSpec.bind(null, featureId, version, baseVersion),
    {},
  );
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
