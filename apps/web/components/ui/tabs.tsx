'use client';

import type { ReactNode } from 'react';
import { Tabs as AriaTabs, Tab, TabList, TabPanel } from 'react-aria-components';

export type TabItem = { id: string; label: string; content: ReactNode; isDisabled?: boolean };

/** Views of one thing, one shown at a time, as pills (ADR 0008). */
export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  'aria-label': ariaLabel,
  className,
}: {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  'aria-label': string;
  className?: string;
}) {
  return (
    <AriaTabs
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={(key) => onChange?.(String(key))}
      disabledKeys={tabs.filter((t) => t.isDisabled).map((t) => t.id)}
      className={className}
    >
      <TabList aria-label={ariaLabel} className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <Tab
            key={t.id}
            id={t.id}
            className="cursor-default rounded-full px-4 py-2 text-sm font-medium text-fg-soft outline-none data-[hovered]:bg-surface-hi data-[hovered]:text-fg data-[selected]:bg-ink-wash data-[selected]:text-ink data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
          >
            {t.label}
          </Tab>
        ))}
      </TabList>
      {tabs.map((t) => (
        <TabPanel
          key={t.id}
          id={t.id}
          className="mt-4 rounded-tile outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          {t.content}
        </TabPanel>
      ))}
    </AriaTabs>
  );
}
