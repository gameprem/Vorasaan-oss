'use client';

import type { ReactNode } from 'react';
import { Switch as AriaSwitch } from 'react-aria-components';
import { controlledOnChange } from './field';

/** On or off for something that takes effect at once, like a setting. */
export function Switch({
  children,
  className,
  onChange,
  ...props
}: {
  children?: ReactNode;
  'aria-label'?: string;
  isSelected?: boolean;
  defaultSelected?: boolean;
  onChange?: (isSelected: boolean) => void;
  name?: string;
  value?: string;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <AriaSwitch
      {...props}
      onChange={controlledOnChange(props.isSelected !== undefined, onChange)}
      className={`group/kit flex cursor-default items-center gap-3 text-fg data-[disabled]:opacity-50 ${className ?? ''}`}
    >
      <span
        aria-hidden
        className="flex h-6 w-10 shrink-0 items-center rounded-full bg-surface-hi p-0.5 ring-1 ring-inset ring-line transition-colors group-data-[selected]/kit:bg-jade group-data-[selected]/kit:ring-jade group-data-[focus-visible]/kit:outline-2 group-data-[focus-visible]/kit:outline-offset-2 group-data-[focus-visible]/kit:outline-focus"
      >
        <span className="size-5 rounded-full bg-bg shadow-card transition-transform group-data-[selected]/kit:translate-x-4" />
      </span>
      {children}
    </AriaSwitch>
  );
}
