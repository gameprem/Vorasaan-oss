'use client';

import { Button as AriaButton, Select as AriaSelect, SelectValue } from 'react-aria-components';
import { ChevronDownIcon } from '../icons';
import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  type FieldProps,
  useFieldValue,
  well,
} from './field';
import { fromKey, type Option, OptionList, selectedKeyFor } from './options';
import { PopoverSurface } from './popover';

export type SelectProps = FieldProps & {
  options: Option[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Shown while nothing is picked. */
  placeholder?: string;
  /** Classes for the button, added to the well. */
  triggerClassName?: string;
};

/** Pick one of a short list. For a long list people search, use ComboBox. */
export function Select({
  label,
  description,
  options,
  value,
  defaultValue = '',
  onChange,
  name,
  placeholder = 'Pick one…',
  isRequired,
  isDisabled,
  className,
  labelClassName,
  triggerClassName,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [current, setCurrent] = useFieldValue(value, defaultValue, onChange);
  const icon = options.find((o) => o.id === current)?.icon;
  return (
    <AriaSelect
      aria-label={ariaLabel}
      value={selectedKeyFor(options, current)}
      onChange={(key) => setCurrent(fromKey(key as string | null))}
      placeholder={placeholder}
      isRequired={isRequired}
      isDisabled={isDisabled}
      validationBehavior="native"
      className={`block ${className ?? ''}`}
    >
      {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
      <AriaButton
        className={`${well} cursor-default text-left data-[pressed]:bg-surface-hi ${triggerClassName ?? ''}`}
      >
        {icon && (
          <span aria-hidden className="flex shrink-0 text-fg-soft">
            {icon}
          </span>
        )}
        <SelectValue className="min-w-0 flex-1 truncate data-[placeholder]:text-fg-soft">
          {({ selectedText, isPlaceholder }) => (isPlaceholder ? placeholder : selectedText)}
        </SelectValue>
        <span aria-hidden className="shrink-0 text-fg-soft">
          <ChevronDownIcon />
        </span>
      </AriaButton>
      <FieldDescription>{description}</FieldDescription>
      <FieldErrorText />
      {name && <input type="hidden" name={name} value={current} disabled={isDisabled} />}
      <PopoverSurface className="min-w-[var(--trigger-width)]">
        <OptionList options={options} />
      </PopoverSurface>
    </AriaSelect>
  );
}
