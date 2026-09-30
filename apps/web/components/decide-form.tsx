'use client';

import type { ChoiceView } from '@vorasaan/shared';
import { useActionState, useState } from 'react';
import { type ActionState, decide } from '@/lib/actions';

const CUSTOM = 'custom';

export function DecideForm({ requestId, choices }: { requestId: string; choices: ChoiceView[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    decide.bind(null, requestId),
    {},
  );
  const [selected, setSelected] = useState<string>(choices.length === 0 ? CUSTOM : '');
  const picked = choices.find((c) => c.id === selected);

  const submitLabel = pending
    ? 'Deciding…'
    : picked
      ? `Decide ${picked.label}: ${picked.title}`
      : selected === CUSTOM
        ? 'Decide with my answer'
        : 'Pick an option to decide';

  return (
    <form action={action} className="mt-8">
      <fieldset>
        <legend className="text-lg font-semibold">
          {choices.length ? 'Pick one' : 'Your answer'}
        </legend>

        {choices.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-xl border border-rule bg-sheet">
            {choices.map((c) => {
              const active = selected === c.id;
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer gap-4 border-b border-rule p-5 last:border-b-0 transition-colors ${
                    active ? 'bg-jade-wash' : 'hover:bg-paper'
                  }`}
                >
                  <input
                    type="radio"
                    name="choice"
                    value={c.id}
                    checked={active}
                    onChange={() => setSelected(c.id)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={`flex size-11 shrink-0 items-center justify-center rounded-full border-2 text-xl font-semibold ${
                      active ? 'border-jade bg-jade text-sheet' : 'border-rule text-ink-soft'
                    }`}
                  >
                    {c.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">
                      <span className="sr-only">Choice {c.label}: </span>
                      {c.title}
                    </span>
                    <span className="mt-1 block max-w-[68ch] text-ink-soft">{c.description}</span>
                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-ink-soft">Scope</dt>
                        <dd className="text-ink">{c.impactScope}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-soft">Time</dt>
                        <dd className="text-ink">{c.impactTime}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-soft">Risk</dt>
                        <dd className="text-ink">{c.impactRisk}</dd>
                      </div>
                    </dl>
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <div className="mt-4">
          {choices.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-ink-soft">
              <input
                type="radio"
                name="choice"
                value={CUSTOM}
                checked={selected === CUSTOM}
                onChange={() => setSelected(CUSTOM)}
                className="accent-jade"
              />
              None of these. Answer in my own words.
            </label>
          )}
          {selected === CUSTOM && (
            <>
              {choices.length === 0 && <input type="hidden" name="choice" value={CUSTOM} />}
              <textarea
                name="customAnswer"
                required
                rows={3}
                aria-label="Your answer"
                placeholder="What should the team do?"
                className="mt-3 w-full max-w-[72ch] rounded-lg border border-rule bg-sheet p-3 text-ink"
              />
            </>
          )}
        </div>
      </fieldset>

      <label className="mt-6 block max-w-[72ch]">
        <span className="text-sm text-ink-soft">Why? (optional, saved in the Decision Log)</span>
        <textarea
          name="rationale"
          rows={2}
          className="mt-1 w-full rounded-lg border border-rule bg-sheet p-3 text-ink"
        />
      </label>

      {state.error && (
        <p role="alert" className="mt-4 text-seal">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !selected}
        className="mt-6 rounded-lg bg-ink px-5 py-2.5 font-medium text-sheet disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitLabel}
      </button>
      {pending && (
        <p className="mt-2 text-sm text-ink-soft">
          Drafting the Spec change. This can take a few seconds.
        </p>
      )}
    </form>
  );
}
