'use client';

import type { ReactNode } from 'react';
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioRenderProps,
} from 'react-aria-components';
import {
  controlledOnChange,
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  type FieldProps,
} from './field';

// One choice of a few, all visible. `plain` radios are a dot and a label; `card` radios
// are tonal tiles that turn ink-washed when picked (the raise form's kinds, the providers).

export function RadioGroup({
  label,
  description,
  value,
  defaultValue,
  onChange,
  name,
  isRequired,
  isDisabled,
  orientation = 'vertical',
  className,
  labelClassName = 'text-sm',
  children,
  'aria-label': ariaLabel,
}: FieldProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  orientation?: 'vertical' | 'horizontal';
  children: ReactNode;
}) {
  return (
    <AriaRadioGroup
      aria-label={ariaLabel}
      // '' is "nothing picked yet", as with a native radio group.
      value={value === '' ? null : value}
      defaultValue={defaultValue}
      onChange={controlledOnChange(value !== undefined, onChange)}
      name={name}
      isRequired={isRequired}
      isDisabled={isDisabled}
      orientation={orientation}
      validationBehavior="native"
      className={`block ${className ?? ''}`}
    >
      {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
      {children}
      <FieldDescription>{description}</FieldDescription>
      <FieldErrorText />
    </AriaRadioGroup>
  );
}

const PLAIN =
  'group/kit flex cursor-default items-start gap-2.5 text-fg data-[disabled]:opacity-50 [&_.radio-dot]:mt-[0.2em]';
const CARD =
  'group/kit flex cursor-default gap-3 rounded-card bg-rail p-4 text-fg data-[hovered]:bg-surface-hi data-[selected]:bg-ink-wash data-[disabled]:opacity-50 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus';

export function Radio({
  value,
  children,
  description,
  variant = 'plain',
  className,
  isDisabled,
}: {
  value: string;
  children: ReactNode | ((state: RadioRenderProps) => ReactNode);
  description?: ReactNode;
  /** `card`: a tile without a dot; `bare`: only `className`, for a fully custom look. */
  variant?: 'plain' | 'card' | 'bare';
  className?: string;
  isDisabled?: boolean;
}) {
  const base = variant === 'plain' ? PLAIN : variant === 'card' ? CARD : '';
  return (
    <AriaRadio value={value} isDisabled={isDisabled} className={`${base} ${className ?? ''}`}>
      {(state) => (
        <>
          {variant === 'plain' && (
            <span
              aria-hidden
              className="radio-dot grid size-[18px] shrink-0 place-items-center rounded-full bg-bg ring-2 ring-inset ring-fg-faint group-data-[selected]/kit:ring-jade group-data-[hovered]/kit:ring-fg-soft group-data-[focus-visible]/kit:outline-2 group-data-[focus-visible]/kit:outline-offset-2 group-data-[focus-visible]/kit:outline-focus"
            >
              <span className="size-2 rounded-full bg-jade opacity-0 group-data-[selected]/kit:opacity-100" />
            </span>
          )}
          {typeof children === 'function' ? (
            children(state)
          ) : (
            <span className="min-w-0">
              <span className="block">{children}</span>
              {description && <span className="block text-sm text-fg-soft">{description}</span>}
            </span>
          )}
        </>
      )}
    </AriaRadio>
  );
}
