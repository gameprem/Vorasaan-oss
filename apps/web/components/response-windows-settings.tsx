'use client';

import {
  type Holiday,
  type ProjectResponseWindowsView,
  type ResponseWindow,
  type ResponseWindowSettingsView,
  type ResponseWindowUnit,
  responseWindowText,
} from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import {
  saveProjectResponseWindows,
  saveResponseWindowSettings,
} from '@/lib/response-window-actions';
import { field, primaryButton, secondaryButton } from './ui';

// Settings → Response Windows (ticket 0055, Admins): the Organization's working calendar,
// its default windows, and each Project's own windows.

const WEEKDAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

function timeZones(current: string): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

function WindowFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ResponseWindow;
  onChange: (next: ResponseWindow) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm">{label}</legend>
      <div className="mt-1 flex gap-2">
        <input
          type="number"
          min={1}
          max={1000}
          aria-label={`${label}: how many`}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) || 1 })}
          className={`${field} w-24`}
        />
        <select
          aria-label={`${label}: unit`}
          value={value.unit}
          onChange={(e) => onChange({ ...value, unit: e.target.value as ResponseWindowUnit })}
          className={field}
        >
          <option value="WORKING_HOURS">working hours</option>
          <option value="WORKING_DAYS">working days</option>
        </select>
      </div>
    </fieldset>
  );
}

function Status({ pending, error, saved }: { pending: boolean; error?: string; saved: boolean }) {
  return (
    <>
      <span role="status" className="text-sm text-fg-soft">
        {pending ? 'Saving…' : saved ? 'Saved' : ''}
      </span>
      {error && (
        <p role="alert" className="mt-2 w-full text-lacquer">
          {error}
        </p>
      )}
    </>
  );
}

/** The Organization's working calendar and default windows. */
export function ResponseWindowSettingsEditor({
  settings,
}: {
  settings: ResponseWindowSettingsView;
}) {
  const id = useId();
  const [form, setForm] = useState(settings);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const change = (patch: Partial<ResponseWindowSettingsView>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
    setError(undefined);
  };
  const setHoliday = (index: number, patch: Partial<Holiday>) =>
    change({ holidays: form.holidays.map((h, i) => (i === index ? { ...h, ...patch } : h)) });

  const save = () =>
    start(async () => {
      const { organizationId: _, ...input } = form;
      const result = await saveResponseWindowSettings({
        ...input,
        holidays: input.holidays.filter((h) => h.date || h.name),
      });
      if (result.error) setError(result.error);
      else setSaved(true);
    });

  return (
    <form action={save} aria-label="Working calendar and default windows" className="space-y-8">
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Working time</h3>
        <label className="block max-w-sm">
          <span className="text-sm">Time zone</span>
          <select
            value={form.timeZone}
            onChange={(e) => change({ timeZone: e.target.value })}
            className={field}
          >
            {timeZones(form.timeZone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="text-sm">Working days</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {WEEKDAYS.map(([day, label]) => (
              <label key={day} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={form.workingDays.includes(day)}
                  onChange={(e) =>
                    change({
                      workingDays: e.target.checked
                        ? [...form.workingDays, day].sort((a, b) => a - b)
                        : form.workingDays.filter((d) => d !== day),
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-4">
          <label className="block">
            <span className="text-sm">Working hours start</span>
            <input
              type="time"
              value={form.workStart}
              onChange={(e) => change({ workStart: e.target.value })}
              className={field}
            />
          </label>
          <label className="block">
            <span className="text-sm">Working hours end</span>
            <input
              type="time"
              value={form.workEnd}
              onChange={(e) => change({ workEnd: e.target.value })}
              className={field}
            />
          </label>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby={`${id}-holidays`}>
        <h3 id={`${id}-holidays`} className="text-lg font-semibold">
          Public holidays
        </h3>
        <p className="text-fg-soft">No working time on these days.</p>
        {form.holidays.length > 0 && (
          <ul className="space-y-2">
            {form.holidays.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
              <li key={i} className="flex flex-wrap items-end gap-2">
                <input
                  type="date"
                  aria-label={`Holiday ${i + 1} date`}
                  value={h.date}
                  onChange={(e) => setHoliday(i, { date: e.target.value })}
                  className={`${field} w-44`}
                />
                <input
                  aria-label={`Holiday ${i + 1} name`}
                  placeholder="Name"
                  maxLength={200}
                  value={h.name}
                  onChange={(e) => setHoliday(i, { name: e.target.value })}
                  className={`${field} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  className={`${secondaryButton} px-3 py-1 text-sm`}
                  onClick={() => change({ holidays: form.holidays.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={secondaryButton}
          onClick={() => change({ holidays: [...form.holidays, { date: '', name: '' }] })}
        >
          Add holiday
        </button>
      </section>

      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Default Response Windows</h3>
        <div className="flex flex-wrap gap-6">
          <WindowFields
            label="Blocker"
            value={form.blocker}
            onChange={(blocker) => change({ blocker })}
          />
          <WindowFields
            label="Question"
            value={form.question}
            onChange={(question) => change({ question })}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          Save Response Windows
        </button>
        <Status pending={pending} error={error} saved={saved} />
      </div>
    </form>
  );
}

/** One Project's own windows; unchecked keeps the Organization default. */
export function ProjectResponseWindowsEditor({
  projectName,
  windows,
  defaults,
}: {
  projectName: string;
  windows: ProjectResponseWindowsView;
  defaults: { blocker: ResponseWindow; question: ResponseWindow };
}) {
  const [blocker, setBlocker] = useState(windows.override.blocker);
  const [question, setQuestion] = useState(windows.override.question);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await saveProjectResponseWindows(windows.projectId, { blocker, question });
      if (result.error) setError(result.error);
      else setSaved(true);
    });

  const row = (
    label: 'Blocker' | 'Question',
    value: ResponseWindow | null,
    set: (next: ResponseWindow | null) => void,
    fallback: ResponseWindow,
  ) => (
    <div className="space-y-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4"
          checked={value !== null}
          onChange={(e) => {
            set(e.target.checked ? fallback : null);
            setSaved(false);
          }}
        />
        {label}: {value ? 'own window' : `Organization default (${responseWindowText(fallback)})`}
      </label>
      {value && (
        <WindowFields
          label={`${projectName} ${label}`}
          value={value}
          onChange={(next) => {
            set(next);
            setSaved(false);
          }}
        />
      )}
    </div>
  );

  return (
    <form action={save} aria-label={`${projectName} Response Windows`} className="py-4">
      <h4 className="font-medium">{projectName}</h4>
      <div className="mt-2 flex flex-wrap gap-8">
        {row('Blocker', blocker, setBlocker, defaults.blocker)}
        {row('Question', question, setQuestion, defaults.question)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={secondaryButton}>
          Save for {projectName}
        </button>
        <Status pending={pending} error={error} saved={saved} />
      </div>
    </form>
  );
}
