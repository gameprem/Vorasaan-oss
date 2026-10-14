'use client';

import type { ProviderModelsView, ProviderModelView } from '@vorasaan/shared';
import { useEffect, useId, useMemo, useState } from 'react';

// A provider's model list as a searchable picker: OpenRouter's (ticket 0064) or the
// Gemini API's (ticket 0080). Picking a model fills the model id (and, in Settings,
// its Context Window from the list). When the list can't be loaded, it says so and
// the Admin types the id instead.

/** How many matches are shown at once; a narrower search shows the rest. */
const SHOWN = 50;

/** Every word of the search, in the model's name or id. */
export function matchesSearch(model: ProviderModelView, search: string): boolean {
  const haystack = `${model.name} ${model.id}`.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** "200k tokens", "1M tokens", "131,072 tokens". */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M tokens`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k tokens`;
  return `${tokens.toLocaleString('en')} tokens`;
}

export function ProviderModelPicker({
  providerName,
  exampleId,
  load,
  selectedId,
  onPick,
  inputClass,
}: {
  /** "OpenRouter" or "Gemini", in the labels and messages. */
  providerName: string;
  /** A model id as this provider spells it, for the fallback message. */
  exampleId: string;
  load: () => Promise<ProviderModelsView>;
  selectedId: string;
  onPick: (model: ProviderModelView) => void;
  inputClass: string;
}) {
  const [list, setList] = useState<ProviderModelsView | null>(null);
  const [search, setSearch] = useState('');
  const searchId = useId();

  useEffect(() => {
    let live = true;
    load()
      .then((result) => live && setList(result))
      .catch(
        () =>
          live && setList({ models: [], error: `Could not load ${providerName}'s model list.` }),
      );
    return () => {
      live = false;
    };
  }, [load, providerName]);

  const matches = useMemo(
    () => (list?.models ?? []).filter((m) => matchesSearch(m, search)),
    [list, search],
  );

  if (!list) {
    return (
      <p role="status" className="text-sm text-fg-soft">
        Loading {providerName}'s models…
      </p>
    );
  }
  if (list.error || list.models.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-soft">
        {list.error ?? `${providerName} listed no models.`} Type the model id instead, e.g.{' '}
        {exampleId}.
      </p>
    );
  }

  return (
    <div>
      <label htmlFor={searchId} className="text-sm">
        Search {providerName} models
      </label>
      <input
        id={searchId}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Name or id"
        autoComplete="off"
        className={inputClass}
      />
      <ul
        aria-label={`${providerName} models`}
        className="mt-2 max-h-56 overflow-y-auto rounded-tile bg-surface"
      >
        {matches.slice(0, SHOWN).map((m) => {
          const selected = m.id === selectedId;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(m)}
                className={`block w-full px-3 py-2 text-left ${
                  selected ? 'bg-ink-wash text-fg' : 'hover:bg-surface-hi'
                }`}
              >
                <span className="block font-medium">{m.name}</span>
                <span className="block text-xs text-fg-soft">
                  {m.id}
                  {m.contextWindow ? ` · ${windowLabel(m.contextWindow)}` : ''}
                </span>
              </button>
            </li>
          );
        })}
        {matches.length === 0 && (
          <li className="px-3 py-2 text-sm text-fg-soft">No model matches. Type its id below.</li>
        )}
      </ul>
      <p className="mt-1 text-xs text-fg-soft">
        {matches.length > SHOWN
          ? `Showing ${SHOWN} of ${matches.length} matches. Narrow the search to see more.`
          : `${matches.length} of ${list.models.length} models.`}
      </p>
    </div>
  );
}
