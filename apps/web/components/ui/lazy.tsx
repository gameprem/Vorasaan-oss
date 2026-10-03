'use client';

import dynamic from 'next/dynamic';

// Kit parts the root layout renders on every page, loaded in their own chunk so a page that
// has no picker of its own doesn't carry them in its first load (ADR 0016: the kit's weight
// lands only where it is used).

/** The toast region; `toast()` from ./toast feeds the same queue. */
export const LazyToaster = dynamic(() => import('./toast').then((m) => m.Toaster), {
  ssr: false,
});

/** A Select in a part of the chat most people never open (Request changes, Redrafts). */
export const LazySelect = dynamic(() => import('./select').then((m) => m.Select));

/** The person picker, for the dev identity switcher in the Sidebar. */
export const LazyPersonPicker = dynamic(() =>
  import('./person-picker').then((m) => m.PersonPicker),
);
