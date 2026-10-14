'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { type DeleteResult, deleteFeature, deleteProject } from '@/lib/delete-actions';
import { announce, markOwnDelete } from '@/lib/deleted';
import { field } from './ui';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/**
 * Deletes a Feature or a Project once the person types its name (ticket 0049): an alert
 * dialog, usable from the keyboard (Enter deletes once the name matches, Escape cancels).
 * Afterwards it goes to `then` and says what happened in the shell's live region.
 */
export function DeleteByName({
  kind,
  id,
  name,
  then,
  consequences,
}: {
  kind: 'Feature' | 'Project';
  id: string;
  name: string;
  /** Where to go once it is deleted. */
  then: string;
  /** What else goes with it, in a sentence or two. */
  consequences: string;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const inputId = useId();
  const hintId = useId();
  const matches = typed.trim() === name.trim();

  const remove = (close: () => void) => {
    if (!matches || pending) return;
    setError('');
    start(async () => {
      markOwnDelete(id);
      const result: DeleteResult = await (kind === 'Feature'
        ? deleteFeature(id)
        : deleteProject(id));
      if (result.error) {
        setError(result.error);
        return;
      }
      close();
      router.replace(then);
      announce(`Deleted the ${kind} “${name}”.`);
    });
  };

  return (
    <Dialog
      trigger={`Delete ${kind}`}
      triggerVariant="danger"
      title={`Delete the ${kind} “${name}”?`}
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) {
          setTyped('');
          setError('');
        }
      }}
    >
      {(close) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            remove(close);
          }}
        >
          <p>{consequences} This can’t be undone.</p>
          <label htmlFor={inputId} className="mt-4 block text-sm font-medium">
            Type the {kind}’s name to confirm
          </label>
          <p id={hintId} className="text-sm text-fg-soft">
            {name}
          </p>
          <input
            id={inputId}
            aria-describedby={hintId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className={field}
          />
          {/* Always rendered, so a screen reader hears the error when it appears. */}
          <p aria-live="polite" className="mt-2 min-h-5 text-sm text-lacquer">
            {error}
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <Button onPress={close}>Cancel</Button>
            <Button type="submit" variant="danger" isDisabled={!matches || pending}>
              {pending ? 'Deleting…' : `Delete ${kind}`}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
