'use client';

import type { ReactNode } from 'react';
import {
  Header,
  type Key,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Text,
} from 'react-aria-components';
import { CheckIcon } from '../icons';

// The list inside Select, ComboBox and their kin: one row per Option, with an optional icon
// and a second line, grouped into sections when Options name one.

export type Option = {
  /** The value: what `onChange` gets and FormData carries. May be '' ("none" or "default"). */
  id: string;
  label: string;
  /** A second, quieter line. */
  description?: string;
  icon?: ReactNode;
  /** Options with the same section are listed under its heading. */
  section?: string;
  isDisabled?: boolean;
  /** More words a ComboBox search matches, not shown. */
  keywords?: string;
};

// React Aria keys can't be '', yet "nothing picked" and "the default" are '' in our forms.
const EMPTY_KEY = '\u0000empty';
export const toKey = (id: string): Key => (id === '' ? EMPTY_KEY : id);
export const fromKey = (key: Key | null): string =>
  key === null || key === EMPTY_KEY ? '' : String(key);

/** The selected key for `value`: null when nothing is picked and no Option is ''. */
export function selectedKeyFor(options: Option[], value: string): Key | null {
  if (value === '' && !options.some((o) => o.id === '')) return null;
  return toKey(value);
}

export function OptionRow({ option }: { option: Option }) {
  return (
    <ListBoxItem
      id={toKey(option.id)}
      textValue={option.label}
      isDisabled={option.isDisabled}
      className="kit-quiet-focus group/kit flex cursor-default items-center gap-3 rounded-[14px] px-3 py-2 text-fg outline-none data-[disabled]:opacity-40 data-[focused]:bg-surface data-[hovered]:bg-surface data-[selected]:text-ink"
    >
      {({ isSelected }) => (
        <>
          {option.icon && (
            <span aria-hidden className="flex shrink-0 items-center text-fg-soft">
              {option.icon}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <Text slot="label" className={`block truncate ${isSelected ? 'font-semibold' : ''}`}>
              {option.label}
            </Text>
            {option.description && (
              <Text slot="description" className="block truncate text-xs text-fg-soft">
                {option.description}
              </Text>
            )}
          </span>
          <span aria-hidden className={`shrink-0 text-ink ${isSelected ? '' : 'invisible'}`}>
            <CheckIcon />
          </span>
        </>
      )}
    </ListBoxItem>
  );
}

/** The Options as a list box, in sections when any Option names one. */
export function OptionList({
  options,
  emptyText = 'No matches',
}: {
  options: Option[];
  emptyText?: string;
}) {
  const sections = [...new Set(options.map((o) => o.section ?? ''))];
  const grouped = sections.some(Boolean);
  return (
    <ListBox
      className="grid gap-0.5 outline-none"
      renderEmptyState={() => <p className="px-3 py-2 text-sm text-fg-soft">{emptyText}</p>}
    >
      {grouped
        ? sections.map((section) => (
            <ListBoxSection key={section || 'none'} id={`section-${section}`}>
              {section && (
                <Header className="px-3 pt-2 pb-1 text-xs font-medium text-fg-soft">
                  {section}
                </Header>
              )}
              {options
                .filter((o) => (o.section ?? '') === section)
                .map((o) => (
                  <OptionRow key={o.id} option={o} />
                ))}
            </ListBoxSection>
          ))
        : options.map((o) => <OptionRow key={o.id} option={o} />)}
    </ListBox>
  );
}
