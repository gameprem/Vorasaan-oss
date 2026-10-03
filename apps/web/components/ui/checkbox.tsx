'use client';

import type { ReactNode } from 'react';
import { Checkbox as AriaCheckbox } from 'react-aria-components';
import { CheckIcon } from '../icons';
import { controlledOnChange } from './field';

export type CheckboxProps = {
  /** The label, next to the box. Without one, pass `aria-label`. */
  children?: ReactNode;
  'aria-label'?: string;
  /** A second line under the label. */
  description?: ReactNode;
  isSelected?: boolean;
  defaultSelected?: boolean;
  onChange?: (isSelected: boolean) => void;
  /** FormData gets `value` (default "on") under `name` while it is ticked. */
  name?: string;
  value?: string;
  isDisabled?: boolean;
  /** `chip`: a pill that turns jade when ticked, for picking several people or tags. */
  variant?: 'plain' | 'chip';
  className?: string;
};

const PLAIN =
  'group/kit flex cursor-default items-start gap-2.5 text-fg data-[disabled]:opacity-50 [&_.box]:mt-[0.2em]';
const CHIP =
  'group/kit flex cursor-default items-center gap-2 rounded-full bg-surface px-3 py-1 text-fg-soft data-[hovered]:bg-surface-hi data-[selected]:bg-jade-wash data-[selected]:text-fg data-[disabled]:opacity-50 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus';

/** A tick box with its label: on or off. */
export function Checkbox({
  children,
  description,
  variant = 'plain',
  className,
  value,
  onChange,
  ...props
}: CheckboxProps) {
  return (
    <AriaCheckbox
      {...props}
      onChange={controlledOnChange(props.isSelected !== undefined, onChange)}
      value={value ?? 'on'}
      className={`${variant === 'chip' ? CHIP : PLAIN} ${className ?? ''}`}
    >
      <span
        aria-hidden
        className="box grid size-[18px] shrink-0 place-items-center rounded-md bg-bg text-transparent ring-2 ring-inset ring-fg-faint group-data-[selected]/kit:bg-jade group-data-[selected]/kit:text-on-ink group-data-[selected]/kit:ring-jade group-data-[hovered]/kit:ring-fg-soft group-data-[focus-visible]/kit:outline-2 group-data-[focus-visible]/kit:outline-offset-2 group-data-[focus-visible]/kit:outline-focus"
      >
        <CheckIcon size={14} />
      </span>
      {(children || description) && (
        <span className="min-w-0">
          {children}
          {description && <span className="block text-sm text-fg-soft">{description}</span>}
        </span>
      )}
    </AriaCheckbox>
  );
}
