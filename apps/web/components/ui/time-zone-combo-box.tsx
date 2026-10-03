'use client';

import { useMemo } from 'react';
import { matchesTimeZone, type TimeZoneOption, timeZoneOptions } from '@/lib/time-zones';
import { GlobeIcon } from '../icons';
import { ComboBox, type ComboBoxProps } from './combo-box';
import type { Option } from './options';

/** The Options of the time-zone picker: the zone id, its city, Thai name and current offset. */
export function timeZonePickerOptions(zones: TimeZoneOption[]): Option[] {
  return zones.map((z) => ({
    id: z.id,
    label: z.id,
    description: [z.offset, z.aliases[0]].filter(Boolean).join(' · '),
    keywords: [z.city, ...z.aliases].join(' '),
  }));
}

/**
 * Pick an IANA time zone by typing a city or zone in English or Thai: "Bangkok" and
 * "กรุงเทพ" both find Asia/Bangkok. Each row shows the zone's current offset.
 */
export function TimeZoneComboBox({
  value,
  defaultValue = '',
  emptyLabel,
  ...props
}: Omit<ComboBoxProps, 'options' | 'matches'> & {
  /** Offer a '' Option with this label, such as "The Organization's (Asia/Bangkok)". */
  emptyLabel?: string;
}) {
  const current = value ?? defaultValue;
  const zones = useMemo(() => timeZoneOptions(current || 'UTC'), [current]);
  const byId = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);
  const options = useMemo(
    () => [
      ...(emptyLabel !== undefined ? [{ id: '', label: emptyLabel }] : []),
      ...timeZonePickerOptions(zones).map((o) => ({ ...o, icon: <GlobeIcon /> })),
    ],
    [zones, emptyLabel],
  );
  return (
    <ComboBox
      placeholder="Search a city or time zone…"
      emptyText="No time zone matches"
      {...props}
      value={value}
      defaultValue={defaultValue}
      options={options}
      matches={(option, query) => {
        const zone = byId.get(option.id);
        return zone
          ? matchesTimeZone(zone, query)
          : option.label.toLowerCase().includes(query.toLowerCase());
      }}
    />
  );
}
