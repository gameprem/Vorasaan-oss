'use client';

import type { PlatformView } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { setFeaturePlatforms } from '@/lib/org-actions';
import { secondaryButton } from './ui';
import { Checkbox } from './ui/checkbox';

/**
 * Tick the Platforms of the Project this Feature targets (ADR 0009). A new Spec starts with a
 * section for each of them.
 */
export function FeaturePlatformsEditor({
  featureId,
  platforms,
  targets,
}: {
  featureId: string;
  platforms: PlatformView[];
  targets: string[];
}) {
  const [selected, setSelected] = useState(() => new Set(targets));
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, start] = useTransition();
  const changed = selected.size !== targets.length || targets.some((id) => !selected.has(id));

  const toggle = (id: string) => {
    setMessage(undefined);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <fieldset className="mb-8">
      <legend className="font-medium">Choose target Platforms</legend>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {platforms.map((p) => (
          <Checkbox
            key={p.id}
            variant="chip"
            isSelected={selected.has(p.id)}
            onChange={() => toggle(p.id)}
          >
            {p.name}
          </Checkbox>
        ))}
        <button
          type="button"
          disabled={pending || !changed}
          className={`${secondaryButton} text-sm`}
          onClick={() =>
            start(async () => {
              const result = await setFeaturePlatforms(featureId, {
                platformIds: platforms.filter((p) => selected.has(p.id)).map((p) => p.id),
              });
              setMessage(
                result.error ? { ok: false, text: result.error } : { ok: true, text: 'Saved.' },
              );
            })
          }
        >
          {pending ? 'Saving…' : 'Save Platforms'}
        </button>
        {message && (
          <p role="status" className={`text-sm ${message.ok ? 'text-jade' : 'text-lacquer'}`}>
            {message.text}
          </p>
        )}
      </div>
    </fieldset>
  );
}
