'use client';

import {
  MAX_PLATFORMS,
  type PlatformDefinition,
  type PlatformView,
  type TeamRole,
} from '@vorasaan/shared';
import { useLayoutEffect, useRef, useState, useTransition } from 'react';
import {
  type PlatformActionState,
  savePlatformTemplate,
  saveProjectPlatforms,
} from '@/lib/platform-actions';
import { field, primaryButton, ROLE_LABEL, secondaryButton } from './ui';
import { Checkbox } from './ui/checkbox';

// Editors for Platforms (ADR 0009, ticket 0052): the Organization's Platform template
// (Settings, Admins) and a Project's own list (its Platforms tab, its POs and Admins). Both
// lists are saved whole; the API replaces them and checks who may do it.

type Check = 'specSection' | 'someoneToAsk' | 'noOpenBlockers' | 'qaReady';

/** The Coverage checks a Platform switches on or off, as people read them. */
export const CHECKS: { key: Check; label: string; description: string }[] = [
  {
    key: 'specSection',
    label: 'Spec section',
    description: 'The Spec has a section for it with something in it.',
  },
  {
    key: 'someoneToAsk',
    label: 'Someone to ask',
    description: 'Someone in the Team holds one of its Team Roles.',
  },
  {
    key: 'noOpenBlockers',
    label: 'No open Blockers',
    description: 'No open Blocker names it in its title or Choices.',
  },
  {
    key: 'qaReady',
    label: 'QA ready',
    description: 'Its section has acceptance criteria or test cases, and someone holds QA.',
  },
];

const ROLES = Object.keys(ROLE_LABEL) as TeamRole[];

type Row = PlatformDefinition & { key: string; id?: string };

let counter = 0;
const newKey = () => `new-${++counter}`;

const blank = (): Row => ({
  key: newKey(),
  name: '',
  roles: [],
  specSection: true,
  someoneToAsk: true,
  noOpenBlockers: true,
  qaReady: true,
});

const definitionOf = (r: Row): PlatformDefinition => ({
  name: r.name.trim(),
  roles: ROLES.filter((role) => r.roles.includes(role)),
  specSection: r.specSection,
  someoneToAsk: r.someoneToAsk,
  noOpenBlockers: r.noOpenBlockers,
  qaReady: r.qaReady,
});

/** One Platform's name, Team Roles and checks. */
function PlatformFields({
  row,
  index,
  onChange,
}: {
  row: Row;
  index: number;
  onChange: (next: Row) => void;
}) {
  return (
    <div className="grid gap-4">
      <label className="block max-w-sm">
        <span className="text-sm">Name</span>
        <input
          value={row.name}
          maxLength={40}
          required
          onChange={(e) => onChange({ ...row, name: e.target.value })}
          placeholder={index === 0 ? 'Back-End' : 'Flutter'}
          className={field}
        />
      </label>
      <fieldset>
        <legend className="text-sm">Team Roles who answer for it</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {ROLES.map((role) => (
            <Checkbox
              key={role}
              variant="chip"
              className="text-sm"
              isSelected={row.roles.includes(role)}
              onChange={(on) =>
                onChange({
                  ...row,
                  roles: on ? [...row.roles, role] : row.roles.filter((r) => r !== role),
                })
              }
            >
              {ROLE_LABEL[role]}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm">Coverage checks</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {CHECKS.map((c) => (
            <Checkbox
              key={c.key}
              isSelected={row[c.key]}
              description={c.description}
              onChange={(on) => onChange({ ...row, [c.key]: on })}
            >
              {c.label}
            </Checkbox>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/**
 * The ordered list, editable: rename, reorder, add, remove, Team Roles and checks. Its
 * status line stays put when a Platform is removed, so what happened is still announced.
 */
function PlatformList({
  initial,
  saveLabel,
  minOne,
  hint,
  onSave,
}: {
  initial: Row[];
  saveLabel: string;
  /** The template can't be saved empty; a Project can (it then targets nothing). */
  minOne: boolean;
  hint: string;
  onSave: (platforms: (PlatformDefinition & { id?: string })[]) => Promise<PlatformActionState>;
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  /** Where the keyboard focus goes after the next render (a move or a removal). */
  const focus = useRef<{ key: string; control: string } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const add = useRef<HTMLButtonElement>(null);

  // After a move or a removal, keep keyboard focus somewhere sensible.
  useLayoutEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target.key === 'add') {
      add.current?.focus();
      return;
    }
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${target.key}"]`);
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-control="${target.control}"]`);
    const fallback = row?.querySelector<HTMLElement>('[data-control]:not([disabled])');
    (wanted && !wanted.disabled ? wanted : fallback)?.focus();
  });

  const change = (next: Row[], message = 'Unsaved changes') => {
    setRows(next);
    setStatus(message);
    setError(undefined);
  };
  const nameOf = (r: Row) => r.name.trim() || 'New Platform';

  const move = (from: number, to: number, control: string) => {
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [row] = next.splice(from, 1);
    if (!row) return;
    next.splice(to, 0, row);
    change(next, `${nameOf(row)} moved to position ${to + 1}. Unsaved changes`);
    focus.current = { key: row.key, control };
  };

  const remove = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const next = rows.filter((r) => r.key !== row.key);
    change(next, `${nameOf(row)} removed. Unsaved changes`);
    const neighbour = next[index] ?? next[index - 1];
    focus.current = neighbour
      ? { key: neighbour.key, control: 'remove' }
      : { key: 'add', control: '' };
  };

  const save = () =>
    start(async () => {
      setError(undefined);
      if (rows.some((r) => !r.name.trim())) {
        setError('Every Platform needs a name.');
        return;
      }
      if (minOne && rows.length === 0) {
        setError('The Platform template needs at least one Platform.');
        return;
      }
      setStatus('Saving…');
      const result = await onSave(
        rows.map((r) => ({ ...definitionOf(r), ...(r.id ? { id: r.id } : {}) })),
      );
      if (result.error) {
        setStatus('Not saved');
        setError(result.error);
      } else setStatus('Saved.');
    });

  const small = `${secondaryButton} px-3 py-1 text-sm`;
  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-fg-soft">No Platforms. Add the parts of the product Features ship on.</p>
      ) : (
        <ol ref={list} className="space-y-4" aria-label="Platforms">
          {rows.map((row, i) => (
            <li key={row.key} data-row={row.key} className="rounded-card bg-rail p-4">
              <fieldset>
                <legend className="mb-3 font-medium">
                  {i + 1}. {nameOf(row)}
                </legend>
                <PlatformFields
                  row={row}
                  index={i}
                  onChange={(next) => change(rows.map((r) => (r.key === row.key ? next : r)))}
                />
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-control="up"
                    className={small}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1, 'up')}
                    aria-label={`Move ${nameOf(row)} up`}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    data-control="down"
                    className={small}
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, i + 1, 'down')}
                    aria-label={`Move ${nameOf(row)} down`}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    data-control="remove"
                    className={small}
                    onClick={() => remove(i)}
                    aria-label={`Remove ${nameOf(row)}`}
                  >
                    Remove
                  </button>
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
      )}
      <button
        ref={add}
        type="button"
        className={`${secondaryButton} mt-4`}
        disabled={rows.length >= MAX_PLATFORMS}
        onClick={() => {
          const row = blank();
          change([...rows, row], 'New Platform added. Unsaved changes');
          requestAnimationFrame(() =>
            list.current?.querySelector<HTMLInputElement>(`[data-row="${row.key}"] input`)?.focus(),
          );
        }}
      >
        Add a Platform
      </button>
      <p className="mt-2 text-sm text-fg-soft">{hint}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} onClick={save} className={primaryButton}>
          {pending ? 'Saving…' : saveLabel}
        </button>
        <span role="status" className="text-sm text-fg-soft">
          {status}
        </span>
      </div>
      <p role="alert" className="mt-2 text-lacquer empty:hidden">
        {error}
      </p>
    </div>
  );
}

// Keys of the rows first rendered are the same on the server and in the browser (they end up
// in `data-row`), so they come from the id or the position, never from a counter.
const rowsOf = (platforms: (PlatformDefinition & { id?: string })[]): Row[] =>
  platforms.map((p, i) => ({ ...p, key: p.id ?? `initial-${i}` }));

/** Settings → Platforms: the Organization's Platform template (Admins). */
export function PlatformTemplateEditor({ platforms }: { platforms: PlatformDefinition[] }) {
  return (
    <PlatformList
      initial={rowsOf(platforms)}
      saveLabel="Save Platform template"
      minOne
      hint="New Projects copy this list. Saving it never changes existing Projects."
      onSave={(list) => savePlatformTemplate({ platforms: list })}
    />
  );
}

/** A Project's Platforms tab: its own list (its POs and Admins). */
export function ProjectPlatformsEditor({
  projectId,
  platforms,
}: {
  projectId: string;
  platforms: PlatformView[];
}) {
  return (
    <PlatformList
      initial={rowsOf(platforms.map(({ position: _position, ...p }) => p))}
      saveLabel="Save Platforms"
      minOne={false}
      hint="Renaming keeps the Features that target a Platform. A Platform that Features target can't be removed until they stop targeting it."
      onSave={(list) => saveProjectPlatforms(projectId, { platforms: list })}
    />
  );
}

/** The list as read by someone who can't change it. */
export function PlatformsList({ platforms }: { platforms: PlatformDefinition[] }) {
  if (platforms.length === 0) return <p className="text-fg-soft">No Platforms yet.</p>;
  return (
    <ol className="rows max-w-3xl" aria-label="Platforms">
      {platforms.map((p) => {
        const on = CHECKS.filter((c) => p[c.key]).map((c) => c.label);
        return (
          <li key={p.name} className="py-3">
            <span className="font-medium">{p.name}</span>
            <span className="block text-sm text-fg-soft">
              Team Roles: {p.roles.length ? p.roles.map((r) => ROLE_LABEL[r]).join(', ') : 'none'}
              {' · '}
              Checks: {on.length ? on.join(', ') : 'none'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
