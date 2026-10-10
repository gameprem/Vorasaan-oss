'use client';

import type { ReactNode } from 'react';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { useFieldValue } from './field';

export type Segment = { id: string; label: string; icon?: ReactNode };

/** Two to four mutually exclusive views or modes, as one pill of buttons. */
export function SegmentedControl({
  segments,
  value,
  defaultValue,
  onChange,
  name,
  isDisabled,
  className,
  'aria-label': ariaLabel,
}: {
  segments: Segment[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  isDisabled?: boolean;
  className?: string;
  /** Names the group; required, since it has no visible label. */
  'aria-label': string;
}) {
  const [current, setCurrent] = useFieldValue(
    value,
    defaultValue ?? segments[0]?.id ?? '',
    onChange,
  );
  return (
    <>
      <ToggleButtonGroup
        aria-label={ariaLabel}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[current]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next !== undefined) setCurrent(String(next));
        }}
        isDisabled={isDisabled}
        className={`inline-flex h-fit w-fit gap-0.5 rounded-full bg-surface p-1 ${className ?? ''}`}
      >
        {segments.map((s) => (
          <ToggleButton
            key={s.id}
            id={s.id}
            className="inline-flex cursor-default items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-fg-soft outline-none data-[hovered]:text-fg data-[selected]:bg-bg data-[selected]:text-ink data-[selected]:shadow-card data-[disabled]:opacity-50 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus"
          >
            {s.icon && <span aria-hidden>{s.icon}</span>}
            {s.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {name && <input type="hidden" name={name} value={current} />}
    </>
  );
}
