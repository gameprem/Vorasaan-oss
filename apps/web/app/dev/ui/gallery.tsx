'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { DocIcon, Flame, GearIcon, InboxIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ComboBox } from '@/components/ui/combo-box';
import { DatePicker, DateRangePicker, TimeField } from '@/components/ui/date-picker';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Menu } from '@/components/ui/menu';
import type { Option } from '@/components/ui/options';
import { PersonPicker } from '@/components/ui/person-picker';
import { Popover } from '@/components/ui/popover';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { TimeZoneComboBox } from '@/components/ui/time-zone-combo-box';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';

type Theme = 'system' | 'light' | 'dark';

const MODELS: Option[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'example/fast-model · quick questions',
    icon: <Flame size={16} />,
  },
  {
    id: 'best',
    label: 'Best',
    description: 'example/large-model · drafting Specs',
    icon: <Flame size={16} />,
  },
  {
    id: 'local',
    label: 'Local',
    description: 'Runs on your server, no data leaves',
    icon: <GearIcon />,
  },
  { id: 'old', label: 'Retired', description: 'No longer approved', isDisabled: true },
];

const ROLES: Option[] = [
  { id: 'PO', label: 'PO' },
  { id: 'DESIGNER', label: 'Designer' },
  { id: 'TECH_LEAD', label: 'Tech Lead' },
  { id: 'BACKEND', label: 'Backend' },
  { id: 'FRONTEND', label: 'Frontend' },
];

const FEATURES: Option[] = [
  { id: 'p1', label: 'Mobile Banking', section: 'Projects', icon: <DocIcon /> },
  { id: 'f1', label: 'Async checkout', section: 'Features', description: 'Mobile Banking' },
  { id: 'f2', label: 'Card freeze', section: 'Features', description: 'Mobile Banking' },
  { id: 'f3', label: 'Refund flow', section: 'Features', description: 'Merchant Portal' },
];

const PEOPLE = [
  { id: 'pim', name: 'Pim Srisuk', roles: ['PO'] as const, email: 'pim@example.com' },
  { id: 'beam', name: 'Beam Chai', roles: ['BACKEND', 'TECH_LEAD'] as const },
  { id: 'fern', name: 'Fern Wong', roles: ['DESIGNER'] as const },
  { id: 'oak', name: 'Oak Tan', roles: ['TECH_LEAD'] as const },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`ui-${id}`} className="rounded-card bg-rail p-5">
      <h2 id={`ui-${id}`} className="mb-4 text-lg font-semibold">
        {title}
      </h2>
      <div className="grid gap-5 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/** The submitted FormData of the demo form, to show that every control posts its value. */
function FormDemo() {
  const [sent, setSent] = useState<string>();
  return (
    <form
      aria-label="Form demo"
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setSent(JSON.stringify(Object.fromEntries(data.entries())));
      }}
    >
      <Select
        label="Decider role"
        name="role"
        options={ROLES}
        isRequired
        placeholder="Pick a Team Role…"
      />
      <ComboBox label="Model" name="model" options={MODELS} defaultValue="best" />
      <PersonPicker
        label="Delegate"
        name="delegate"
        people={PEOPLE.map((p) => ({ ...p }))}
        isRequired
      />
      <TimeZoneComboBox label="Time zone" name="timeZone" defaultValue="Asia/Bangkok" />
      <DatePicker label="Holiday" name="holiday" defaultValue="2026-04-13" />
      <DatePicker
        label="Starts"
        name="startsAt"
        granularity="minute"
        defaultValue="2026-10-05T09:00"
      />
      <TimeField label="Quiet from" name="quietFrom" defaultValue="22:00" />
      <RadioGroup label="Kind" name="kind" defaultValue="BLOCKER">
        <Radio value="BLOCKER">Blocker</Radio>
        <Radio value="QUESTION">Question</Radio>
      </RadioGroup>
      <Checkbox name="plainText">Ask as plain text</Checkbox>
      <Switch name="notify" defaultSelected>
        Notify the Team
      </Switch>
      <SegmentedControl
        aria-label="Unit"
        name="unit"
        segments={[
          { id: 'WORKING_HOURS', label: 'Hours' },
          { id: 'WORKING_DAYS', label: 'Days' },
        ]}
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary">
          Submit the demo
        </Button>
      </div>
      <output aria-label="Submitted values" className="font-mono text-sm break-all sm:col-span-2">
        {sent}
      </output>
    </form>
  );
}

export function UiGallery({ theme: initialTheme }: { theme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [tz, setTz] = useState('Asia/Bangkok');
  const [day, setDay] = useState('2026-03-05');
  const [range, setRange] = useState({ start: '2026-09-01', end: '2026-09-30' });
  const [switchOn, setSwitchOn] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">UI kit</h1>
          <p className="text-fg-soft">
            Every component in components/ui, in every state (ADR 0016). Dev only.
          </p>
        </div>
        <SegmentedControl
          aria-label="Theme"
          value={theme}
          onChange={(t) => setTheme(t as Theme)}
          segments={[
            { id: 'system', label: 'System' },
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
      </header>

      <Section id="buttons" title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Remove</Button>
          <Button variant="primary" isDisabled>
            Disabled
          </Button>
        </div>
      </Section>

      <Section id="select" title="Select">
        <Select
          label="Approved Model"
          options={MODELS}
          defaultValue="best"
          description="With an icon and a second line per item."
        />
        <Select label="Team Role" options={ROLES} placeholder="Pick a Team Role…" />
        <Select label="Unit (disabled)" options={ROLES} defaultValue="PO" isDisabled />
        <Select
          label="Language"
          options={[
            { id: '', label: "The Organization's (English)" },
            { id: 'en', label: 'English' },
            { id: 'th', label: 'ไทย (Thai)' },
          ]}
          defaultValue=""
        />
      </Section>

      <Section id="combobox" title="ComboBox">
        <ComboBox
          label="Project or Feature"
          options={FEATURES}
          placeholder="Search…"
          description="Grouped into sections."
        />
        <ComboBox label="Model" options={MODELS} defaultValue="fast" />
        <PersonPicker
          label="Person"
          people={PEOPLE.map((p) => ({ ...p }))}
          description="Avatar and Team Roles; search by name or email."
        />
        <PersonPicker
          label="Person (disabled)"
          people={[]}
          placeholder="Nobody holds this Team Role"
          isDisabled
        />
        <TimeZoneComboBox
          label="Time zone"
          value={tz}
          onChange={setTz}
          description={`Try "Bangkok" or "กรุงเทพ". Picked: ${tz || 'none'}`}
        />
        <TimeZoneComboBox
          label="Your time zone"
          emptyLabel="The Organization's (Asia/Bangkok)"
          defaultValue=""
        />
      </Section>

      <Section id="dates" title="Date and time">
        <DatePicker
          label="Holiday"
          value={day}
          onChange={setDay}
          description={`Stored: ${day || 'nothing'}`}
        />
        <DatePicker
          label="Holiday (Buddhist era)"
          value={day}
          onChange={setDay}
          buddhistEra
          description="2569 for 2026; the same ISO date is stored."
        />
        <DatePicker label="Starts" granularity="minute" defaultValue="2026-10-05T09:00" />
        <DatePicker
          label="Ends (disabled)"
          granularity="minute"
          defaultValue="2026-10-09T17:30"
          isDisabled
        />
        <TimeField label="Working hours start" defaultValue="09:00" />
        <DateRangePicker
          label="Decision Lead Time range"
          value={range}
          onChange={setRange}
          description={`${range.start} to ${range.end}`}
        />
      </Section>

      <Section id="choices" title="Checkbox, Radio group, Switch, Segmented control">
        <div className="grid gap-3">
          <Checkbox>Mon</Checkbox>
          <Checkbox defaultSelected>Tue</Checkbox>
          <Checkbox isDisabled>Sat (disabled)</Checkbox>
          <Checkbox description="The Decider answers in their own words.">
            Ask as plain text, without Choices
          </Checkbox>
          <div className="flex flex-wrap gap-2">
            <Checkbox variant="chip" defaultSelected>
              Pim
            </Checkbox>
            <Checkbox variant="chip">Beam</Checkbox>
          </div>
        </div>
        <RadioGroup label="Send to" defaultValue="all">
          <div className="mt-2 grid gap-2">
            <Radio value="all">All 2 POs. The first to Claim it decides.</Radio>
            <Radio value="pim">Only Pim</Radio>
            <Radio value="mint" isDisabled>
              Only Mint (away)
            </Radio>
          </div>
        </RadioGroup>
        <RadioGroup
          label="What kind of request is it?"
          defaultValue="BLOCKER"
          className="sm:col-span-2"
        >
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Radio
              value="BLOCKER"
              variant="card"
              description="Your work stops until it is decided."
            >
              <span className="font-medium">Blocker</span>
            </Radio>
            <Radio value="QUESTION" variant="card" description="You keep working meanwhile.">
              <span className="font-medium">Question</span>
            </Radio>
          </div>
        </RadioGroup>
        <div className="grid gap-3">
          <Switch isSelected={switchOn} onChange={setSwitchOn}>
            Hold cards during quiet hours
          </Switch>
          <Switch>Send a weekly summary</Switch>
          <Switch isDisabled>Disabled</Switch>
        </div>
        <SegmentedControl
          aria-label="Window unit"
          segments={[
            { id: 'h', label: 'Working hours' },
            { id: 'd', label: 'Working days' },
          ]}
        />
      </Section>

      <Section id="overlays" title="Menu, Popover, Tooltip, Toast, Dialog">
        <div className="flex flex-wrap items-center gap-2">
          <Menu
            trigger={
              <>
                <PlusIcon /> New
              </>
            }
            actions={[
              { id: 'conversation', label: 'New Conversation', icon: <InboxIcon /> },
              {
                id: 'request',
                label: 'Raise a Decision Request',
                description: 'A Blocker or a Question',
              },
              { id: 'archive', label: 'Archive', tone: 'danger', separatorBefore: true },
            ]}
            onAction={(id) => toast({ title: `Picked ${id}` })}
          />
          <Popover trigger="Filters" title="Filters">
            <div className="grid gap-2">
              <Checkbox defaultSelected>Blockers</Checkbox>
              <Checkbox>Questions</Checkbox>
            </div>
          </Popover>
          <Tooltip content="Search the Spec and its Attachments">
            <button type="button" aria-label="Search" className="icon-btn">
              <SearchIcon />
            </button>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onPress={() => toast({ title: 'Saved' })}>Toast</Button>
          <Button onPress={() => toast({ title: 'Spec v4 approved', tone: 'success' })}>
            Success toast
          </Button>
          <Button
            onPress={() =>
              toast({
                title: "Couldn't save",
                description: 'The server is not reachable.',
                tone: 'error',
              })
            }
          >
            Error toast
          </Button>
          <Dialog
            trigger="Open dialog"
            title="Withdraw this Decision Request?"
            isOpen={dialogOpen}
            onOpenChange={setDialogOpen}
          >
            {(close) => (
              <>
                <p className="text-fg-soft">
                  The Decider stops seeing it. You can raise it again later.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button onPress={close}>Cancel</Button>
                  <Button variant="danger" onPress={close}>
                    Withdraw
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </div>
      </Section>

      <Section id="tabs" title="Tabs">
        <Tabs
          aria-label="Project"
          className="sm:col-span-2"
          tabs={[
            {
              id: 'spec',
              label: 'Spec',
              content: <p className="text-fg-soft">The current Spec.</p>,
            },
            {
              id: 'requests',
              label: 'Decision Requests',
              content: <p className="text-fg-soft">Two open.</p>,
            },
            { id: 'history', label: 'History', content: <p className="text-fg-soft">Versions.</p> },
            { id: 'locked', label: 'Locked', content: null, isDisabled: true },
          ]}
        />
      </Section>

      <Section id="loading" title="Skeleton and Empty state">
        <div className="grid gap-3" role="status" aria-busy="true" aria-label="Loading example">
          <Skeleton className="h-6 w-1/2" />
          <SkeletonText lines={3} />
        </div>
        <EmptyState
          icon={<InboxIcon size={20} />}
          title="Nothing waits for you"
          action={<Button variant="primary">Raise a Decision Request</Button>}
        >
          Decision Requests sent to you appear here.
        </EmptyState>
      </Section>

      <section aria-labelledby="ui-form" className="rounded-card bg-rail p-5">
        <h2 id="ui-form" className="mb-4 text-lg font-semibold">
          In a form
        </h2>
        <FormDemo />
      </section>
    </div>
  );
}
