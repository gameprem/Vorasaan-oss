'use client';

import { useMemo } from 'react';
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  Group,
  Input,
  useFilter,
} from 'react-aria-components';
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

export type ComboBoxProps = FieldProps & {
  options: Option[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Shown when the search matches nothing. */
  emptyText?: string;
  /** Whether an Option matches what was typed; by default its label, description or keywords. */
  matches?: (option: Option, query: string) => boolean;
  inputClassName?: string;
};

/** Pick one of a long list by typing to search it. */
export function ComboBox({
  label,
  description,
  options,
  value,
  defaultValue = '',
  onChange,
  name,
  placeholder,
  emptyText,
  matches,
  isRequired,
  isDisabled,
  className,
  labelClassName,
  inputClassName,
  'aria-label': ariaLabel,
}: ComboBoxProps) {
  const [current, setCurrent] = useFieldValue(value, defaultValue, onChange);
  const { contains } = useFilter({ sensitivity: 'base' });
  // React Aria filters on each row's text (its label); look the Option up to search more.
  const byLabel = useMemo(() => {
    const map = new Map<string, Option[]>();
    for (const o of options) map.set(o.label, [...(map.get(o.label) ?? []), o]);
    return map;
  }, [options]);
  const filter = (text: string, query: string) =>
    (byLabel.get(text) ?? []).some((o) =>
      matches
        ? matches(o, query)
        : query
            .split(/\s+/)
            .filter(Boolean)
            .every((word) =>
              contains([o.label, o.description, o.keywords].filter(Boolean).join(' '), word),
            ),
    );
  const icon = options.find((o) => o.id === current)?.icon;

  return (
    <AriaComboBox
      aria-label={ariaLabel}
      selectedKey={selectedKeyFor(options, current)}
      onSelectionChange={(key) => setCurrent(fromKey(key))}
      defaultFilter={filter}
      allowsEmptyCollection
      isRequired={isRequired}
      isDisabled={isDisabled}
      validationBehavior="native"
      className={`group/kit block ${className ?? ''}`}
    >
      {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
      <Group className={`${well} pr-1.5 ${inputClassName ?? ''}`}>
        {icon && (
          <span aria-hidden className="flex shrink-0 text-fg-soft">
            {icon}
          </span>
        )}
        <Input
          placeholder={placeholder}
          className="w-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-soft kit-quiet-focus"
        />
        <AriaButton className="grid size-7 shrink-0 place-items-center rounded-full text-fg-soft outline-none data-[hovered]:bg-surface-hi data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus">
          <ChevronDownIcon />
        </AriaButton>
      </Group>
      <FieldDescription>{description}</FieldDescription>
      <FieldErrorText />
      {name && <input type="hidden" name={name} value={current} disabled={isDisabled} />}
      <PopoverSurface className="min-w-[var(--trigger-width)]">
        <OptionList options={options} emptyText={emptyText} />
      </PopoverSurface>
    </AriaComboBox>
  );
}
