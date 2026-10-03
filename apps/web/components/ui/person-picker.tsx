'use client';

import type { TeamRole } from '@vorasaan/shared';
import { ROLE_LABEL } from '../ui';
import { ComboBox, type ComboBoxProps } from './combo-box';
import type { Option } from './options';

export type Person = {
  id: string;
  name: string;
  /** Their Team Roles, shown under the name. */
  roles?: readonly TeamRole[];
  email?: string;
  /** Said after the name, such as "(you)". */
  note?: string;
};

/** A person's initials on a round tile, like the Sidebar's. */
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className="grid shrink-0 place-items-center rounded-full bg-ink-wash font-semibold text-ink"
    >
      {initials}
    </span>
  );
}

export const personOption = (p: Person): Option => ({
  id: p.id,
  label: p.note ? `${p.name} ${p.note}` : p.name,
  description:
    [p.roles?.map((r) => ROLE_LABEL[r]).join(', '), p.email].filter(Boolean).join(' · ') ||
    undefined,
  icon: <Avatar name={p.name} />,
  keywords: p.email,
});

/** Pick a person: a searchable list with each one's avatar and Team Roles. */
export function PersonPicker({
  people,
  extra = [],
  placeholder = 'Search people…',
  ...props
}: Omit<ComboBoxProps, 'options'> & {
  people: Person[];
  /** Options listed before the people, such as "Nobody". */
  extra?: Option[];
}) {
  return (
    <ComboBox
      {...props}
      placeholder={placeholder}
      emptyText="Nobody matches"
      options={[...extra, ...people.map(personOption)]}
    />
  );
}
