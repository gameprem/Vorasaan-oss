'use client';

import { type ReactNode, useState } from 'react';
import { FieldError, Label, Text } from 'react-aria-components';

// The pieces every kit field shares (ticket 0077, ADR 0016): the label, the hint under the
// control, the error, and the tonal "well" a control sits in (ADR 0008: no hard borders).

/** The well of a text-like control: a tonal surface with a faint inset ring. */
export const well =
  'mt-1 flex w-full min-w-0 items-center gap-2 rounded-tile bg-surface px-3 py-2 text-fg ring-1 ring-inset ring-line outline-none data-[focus-within]:ring-2 data-[focus-within]:ring-focus data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus data-[disabled]:opacity-50 data-[invalid]:ring-lacquer';

/** The props every kit field takes, named the same everywhere. */
export type FieldProps = {
  /** The visible label. Without one, pass `aria-label`. */
  label?: ReactNode;
  'aria-label'?: string;
  /** A hint under the control. */
  description?: ReactNode;
  /** The form field name: the value goes into FormData under it. */
  name?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  /** Classes for the field's outer element. */
  className?: string;
  /** Classes for the label, `text-sm` by default. */
  labelClassName?: string;
};

export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <Label className={className ?? 'text-sm'}>{children}</Label>;
}

export function FieldDescription({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <Text slot="description" className="mt-1 block text-sm text-fg-soft">
      {children}
    </Text>
  );
}

export function FieldErrorText() {
  return <FieldError className="mt-1 block text-sm text-lacquer" />;
}

/**
 * A value that is controlled when `value` is given and kept here otherwise, so a field
 * can render its own hidden input either way.
 */
export function useFieldValue<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [own, setOwn] = useState(defaultValue);
  const current = value === undefined ? own : value;
  return [
    current,
    (next) => {
      // React Aria may report the value it already has (a re-render, a refresh); that is
      // not a change, and forms that reset "Saved" on change must not hear it.
      if (Object.is(next, current)) return;
      if (value === undefined) setOwn(next);
      else if (isFormResetting()) return;
      onChange?.(next);
    },
  ];
}

// React 19 resets a <form action={fn}> after the action. React Aria hears the reset and sets
// each field back to its first value; a native input that React controls keeps its value
// instead. So while a form resets, controlled kit fields ignore it, as native ones do.
let resetting = false;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'reset',
    () => {
      resetting = true;
      setTimeout(() => {
        resetting = false;
      });
    },
    true,
  );
}

/** Whether a form is resetting right now (see above). */
export const isFormResetting = () => resetting;

/** `onChange` for a controlled field, deaf to form resets; uncontrolled fields still reset. */
export function controlledOnChange<T>(
  controlled: boolean,
  onChange: ((next: T) => void) | undefined,
): ((next: T) => void) | undefined {
  if (!onChange || !controlled) return onChange;
  return (next) => {
    if (!resetting) onChange(next);
  };
}
