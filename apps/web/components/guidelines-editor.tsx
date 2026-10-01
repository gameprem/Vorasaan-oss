'use client';

import type {
  GuidelineCriterionKind,
  GuidelineCriterionText,
  GuidelineCriterionView,
  ProjectGuidelineOverrideInput,
  ProjectGuidelineOverrideView,
} from '@vorasaan/shared';
import { MAX_GUIDELINE_CRITERIA } from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import { saveOrgGuidelines, saveProjectGuidelines } from '@/lib/project-actions';
import { GuidelineKindLabel } from './guidelines-list';
import { field, primaryButton, secondaryButton } from './ui';

// Editors for the Feature Guidelines: the Organization default (Settings, Admins) and a
// Project's overrides (its POs and Admins). Both lists are saved whole; the API replaces them
// atomically and checks who may do it.

type Text = GuidelineCriterionText;
type Row = Text & { key: string };

const KINDS: GuidelineCriterionKind[] = ['KPI', 'CONSTRAINT', 'REQUIRED_SECTION'];

const blank = (): Text => ({ title: '', description: '', kind: 'KPI', required: true });
const textOf = ({ title, description, kind, required }: Text): Text => ({
  title,
  description,
  kind,
  required,
});

let counter = 0;
const newKey = () => `new-${++counter}`;

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Title, description, kind and required, for one criterion. */
function CriterionFields({ value, onChange }: { value: Text; onChange: (next: Text) => void }) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
      <label className="block">
        <span className="text-sm">Title</span>
        <input
          value={value.title}
          maxLength={200}
          required
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="Raises weekly active users"
          className={field}
        />
      </label>
      <label className="block">
        <span className="text-sm">Kind</span>
        <select
          value={value.kind}
          onChange={(e) => onChange({ ...value, kind: e.target.value as GuidelineCriterionKind })}
          className={field}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {GuidelineKindLabel[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-sm">Description (optional)</span>
        <textarea
          value={value.description}
          maxLength={2000}
          rows={2}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          className={field}
        />
      </label>
      <div className="flex items-center gap-2 sm:col-span-2">
        <input
          id={`${id}-required`}
          type="checkbox"
          checked={value.required}
          onChange={(e) => onChange({ ...value, required: e.target.checked })}
          className="size-4"
        />
        <label htmlFor={`${id}-required`} className="text-sm">
          Required (a Feature that doesn't meet it doesn't fit)
        </label>
      </div>
    </div>
  );
}

function RowButtons({
  index,
  count,
  label,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  label: string;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const small = `${secondaryButton} px-3 py-1 text-sm`;
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={small}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
        aria-label={`Move “${label}” up`}
      >
        Up
      </button>
      <button
        type="button"
        className={small}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
        aria-label={`Move “${label}” down`}
      >
        Down
      </button>
      <button type="button" className={small} onClick={onRemove} aria-label={`Remove “${label}”`}>
        Remove
      </button>
    </div>
  );
}

function SaveBar({
  pending,
  error,
  saved,
  onSave,
  dirty,
}: {
  pending: boolean;
  error?: string;
  saved: boolean;
  dirty: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} onClick={onSave} className={primaryButton}>
          {pending ? 'Saving…' : 'Save Feature Guidelines'}
        </button>
        <span role="status" className="text-sm text-ink-soft">
          {dirty ? 'Unsaved changes' : saved ? 'Saved' : ''}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-seal">
          {error}
        </p>
      )}
    </div>
  );
}

/** Settings → Feature Guidelines: the ordered Organization default. */
export function OrgGuidelinesEditor({ criteria }: { criteria: GuidelineCriterionView[] }) {
  const [rows, setRows] = useState<(Row & { id?: string })[]>(() =>
    criteria.map((c) => ({ ...textOf(c), id: c.id, key: c.id })),
  );
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const change = (next: typeof rows) => {
    setRows(next);
    setDirty(true);
    setError(undefined);
  };

  const save = () =>
    start(async () => {
      setError(undefined);
      if (rows.some((r) => !r.title.trim())) return setError('Every criterion needs a title.');
      const result = await saveOrgGuidelines({
        criteria: rows.map((r) => ({ ...textOf(r), ...(r.id ? { id: r.id } : {}) })),
      });
      if (result.error) setError(result.error);
      else {
        setDirty(false);
        setSaved(true);
      }
    });

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-ink-soft">
          No criteria yet. Add what every new Feature must serve or respect.
        </p>
      ) : (
        <ol className="space-y-4">
          {rows.map((row, i) => (
            <li key={row.key} className="rounded-xl border border-rule bg-sheet p-4">
              <fieldset>
                <legend className="mb-3 flex w-full flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {i + 1}. {row.title || 'New criterion'}
                  </span>
                </legend>
                <CriterionFields
                  value={row}
                  onChange={(next) =>
                    change(rows.map((r) => (r.key === row.key ? { ...r, ...next } : r)))
                  }
                />
                <div className="mt-3">
                  <RowButtons
                    index={i}
                    count={rows.length}
                    label={row.title || 'New criterion'}
                    onMove={(to) => change(move(rows, i, to))}
                    onRemove={() => change(rows.filter((r) => r.key !== row.key))}
                  />
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className={`${secondaryButton} mt-4`}
        disabled={rows.length >= MAX_GUIDELINE_CRITERIA}
        onClick={() => change([...rows, { ...blank(), key: newKey() }])}
      >
        Add a criterion
      </button>
      <p className="mt-2 text-sm text-ink-soft">
        Removing a criterion also removes every Project’s edits of it.
      </p>
      <SaveBar pending={pending} error={error} saved={saved} dirty={dirty} onSave={save} />
    </div>
  );
}

type Inherited = {
  /** The Organization default criterion. */
  defaultId: string;
  /** Its text in the Organization default. */
  original: Text;
  mode: 'INHERIT' | 'EDIT' | 'DISABLE';
  edit: Text;
};

/** Project → Guidelines: edit or hide inherited criteria, and add the Project's own. */
export function ProjectGuidelinesEditor({
  projectId,
  overrides,
  orgDefault,
}: {
  projectId: string;
  overrides: ProjectGuidelineOverrideView[];
  /** The Organization default, which every member reads, including criteria this Project hides. */
  orgDefault: GuidelineCriterionView[];
}) {
  const [inherited, setInherited] = useState<Inherited[]>(() => {
    const edits = new Map(
      overrides.flatMap((o) => (o.action === 'EDIT' ? [[o.overridesId, textOf(o)] as const] : [])),
    );
    const hidden = new Set(
      overrides.flatMap((o) => (o.action === 'DISABLE' ? [o.overridesId] : [])),
    );
    return orgDefault.map((c) => {
      const original = textOf(c);
      const edit = edits.get(c.id);
      return {
        defaultId: c.id,
        original,
        mode: hidden.has(c.id) ? 'DISABLE' : edit ? 'EDIT' : 'INHERIT',
        edit: edit ?? original,
      };
    });
  });
  const [added, setAdded] = useState<Row[]>(() =>
    overrides.flatMap((o) => (o.action === 'ADD' ? [{ ...textOf(o), key: o.id }] : [])),
  );
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const touched = () => {
    setDirty(true);
    setError(undefined);
  };
  const setOne = (defaultId: string, patch: Partial<Inherited>) => {
    setInherited((list) => list.map((c) => (c.defaultId === defaultId ? { ...c, ...patch } : c)));
    touched();
  };

  const save = () =>
    start(async () => {
      setError(undefined);
      const edited = inherited.filter((c) => c.mode === 'EDIT');
      if ([...edited.map((c) => c.edit), ...added].some((t) => !t.title.trim())) {
        return setError('Every criterion needs a title.');
      }
      const list: ProjectGuidelineOverrideInput[] = [
        ...inherited.flatMap((c): ProjectGuidelineOverrideInput[] =>
          c.mode === 'EDIT'
            ? [{ action: 'EDIT', overridesId: c.defaultId, ...textOf(c.edit) }]
            : c.mode === 'DISABLE'
              ? [{ action: 'DISABLE', overridesId: c.defaultId }]
              : [],
        ),
        ...added.map((a): ProjectGuidelineOverrideInput => ({ action: 'ADD', ...textOf(a) })),
      ];
      const result = await saveProjectGuidelines(projectId, { overrides: list });
      if (result.error) setError(result.error);
      else {
        setDirty(false);
        setSaved(true);
      }
    });

  return (
    <div>
      <h3 className="font-semibold">From the Organization</h3>
      {inherited.length === 0 ? (
        <p className="mt-2 text-ink-soft">
          The Organization has no Feature Guidelines. An Admin sets them in Settings.
        </p>
      ) : (
        <ol className="mt-3 space-y-4">
          {inherited.map((c) => {
            return (
              <li key={c.defaultId} className="rounded-xl border border-rule bg-sheet p-4">
                <fieldset>
                  <legend className="font-medium">{c.original.title}</legend>
                  {c.original.description && c.mode !== 'EDIT' && (
                    <p className="mt-1 text-sm text-ink-soft">{c.original.description}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    {(
                      [
                        ['INHERIT', 'Use as is'],
                        ['EDIT', 'Edit for this Project'],
                        ['DISABLE', 'Hide in this Project'],
                      ] as const
                    ).map(([mode, text]) => (
                      <label key={mode} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`mode-${c.defaultId}`}
                          checked={c.mode === mode}
                          onChange={() => setOne(c.defaultId, { mode })}
                        />
                        {text}
                      </label>
                    ))}
                  </div>
                  {c.mode === 'EDIT' && (
                    <div className="mt-3">
                      <CriterionFields
                        value={c.edit}
                        onChange={(edit) => setOne(c.defaultId, { edit })}
                      />
                    </div>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}

      <h3 className="mt-8 font-semibold">Only in this Project</h3>
      {added.length === 0 ? (
        <p className="mt-2 text-ink-soft">None yet.</p>
      ) : (
        <ol className="mt-3 space-y-4">
          {added.map((row, i) => (
            <li key={row.key} className="rounded-xl border border-rule bg-sheet p-4">
              <fieldset>
                <legend className="mb-3 font-medium">{row.title || 'New criterion'}</legend>
                <CriterionFields
                  value={row}
                  onChange={(next) => {
                    setAdded((list) =>
                      list.map((r) => (r.key === row.key ? { ...r, ...next } : r)),
                    );
                    touched();
                  }}
                />
                <div className="mt-3">
                  <RowButtons
                    index={i}
                    count={added.length}
                    label={row.title || 'New criterion'}
                    onMove={(to) => {
                      setAdded((list) => move(list, i, to));
                      touched();
                    }}
                    onRemove={() => {
                      setAdded((list) => list.filter((r) => r.key !== row.key));
                      touched();
                    }}
                  />
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className={`${secondaryButton} mt-4`}
        onClick={() => {
          setAdded((list) => [...list, { ...blank(), key: newKey() }]);
          touched();
        }}
      >
        Add a criterion for this Project
      </button>
      <SaveBar pending={pending} error={error} saved={saved} dirty={dirty} onSave={save} />
    </div>
  );
}
