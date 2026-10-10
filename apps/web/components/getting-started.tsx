'use client';

import {
  GETTING_STARTED_LABEL,
  type GettingStartedItemKey,
  type GettingStartedView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { useActionState } from 'react';
import { type ActionState, dismissGettingStarted } from '@/lib/getting-started-actions';

// The Getting started checklist (ticket 0063), on the Admin's Inbox until it is complete or
// they dismiss it. Nothing here is ticked by hand: the server reads each item from what exists.

const HINT: Record<GettingStartedItemKey, string> = {
  PROJECT_AND_TEAM: 'A Project is a product you build; a Team works on it.',
  FEATURE_WITH_SPEC: 'Add a Feature to a Team, then write the first version of its Spec.',
  INVITE_MEMBERS: 'Send an invitation; it counts once they accept.',
  LINK_CLI: 'Create an Access token, then run vorasaan login and paste it.',
  CHAT_APP: 'Optional: people get Decision Requests and decide in LINE, Slack or Teams.',
};

export function GettingStarted({
  view,
  hrefs,
  welcome,
}: {
  view: GettingStartedView;
  /** Where each item is done. */
  hrefs: Record<GettingStartedItemKey, string>;
  /** Right after setup. */
  welcome: boolean;
}) {
  const [state, dismiss, pending] = useActionState<ActionState>(dismissGettingStarted, {});
  const left = view.items.filter((i) => !i.done && !i.optional).length;

  return (
    <section aria-labelledby="getting-started" className="rounded-card bg-rail px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="getting-started" className="text-lg font-semibold">
          Getting started
        </h2>
        <form action={dismiss}>
          <button
            type="submit"
            disabled={pending}
            className="text-sm text-fg-soft underline underline-offset-2 hover:text-fg disabled:opacity-40"
          >
            Dismiss
          </button>
        </form>
      </div>
      <p className="mt-1 text-fg-soft">
        {welcome ? 'Vorasaan is ready. ' : ''}
        {left === 1 ? 'One step left' : `${left} steps left`} to get your team working. Each one
        ticks itself when it's done.
      </p>
      <ol className="mt-3 space-y-2">
        {view.items.map((item) => (
          <li
            key={item.key}
            data-done={item.done}
            aria-label={`${GETTING_STARTED_LABEL[item.key]}: ${item.done ? 'done' : 'to do'}`}
            className="flex items-start gap-3"
          >
            <span
              aria-hidden
              className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs ${
                item.done ? 'bg-ink text-on-ink' : 'ring-1 ring-inset ring-line'
              }`}
            >
              {item.done ? '✓' : ''}
            </span>
            <span className="min-w-0">
              {item.done ? (
                <span className="text-fg-soft line-through">{GETTING_STARTED_LABEL[item.key]}</span>
              ) : (
                <Link
                  href={hrefs[item.key]}
                  className="font-medium text-fg underline underline-offset-2"
                >
                  {GETTING_STARTED_LABEL[item.key]}
                </Link>
              )}
              {!item.done && <span className="block text-sm text-fg-soft">{HINT[item.key]}</span>}
            </span>
          </li>
        ))}
      </ol>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-lacquer">
          {state.error}
        </p>
      )}
    </section>
  );
}
