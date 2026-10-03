'use client';

import type { ChoiceView } from '@vorasaan/shared';
import { useActionState, useState } from 'react';
import { type ActionState, decide } from '@/lib/actions';
import { Radio, RadioGroup } from './ui/radio-group';

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
      {choices.length > 0 ? (
        <RadioGroup
          label="Pick one"
          labelClassName="text-lg font-semibold"
          name="choice"
          value={selected}
          onChange={setSelected}
        >
          <div className="mt-4 overflow-hidden rounded-card bg-rail">
            {choices.map((c) => (
              <Radio
                key={c.id}
                value={c.id}
                variant="bare"
                className="group/kit flex cursor-pointer gap-4 border-b-2 border-bg p-5 transition-colors last:border-b-0 data-[hovered]:bg-surface-hi data-[selected]:bg-jade-wash data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
              >
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-full bg-bg text-xl font-semibold text-ink group-data-[selected]/kit:bg-jade group-data-[selected]/kit:text-on-ink"
                >
                  {c.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-fg">
                    <span className="sr-only">Choice {c.label}: </span>
                    {c.title}
                  </span>
                  <span className="mt-1 block max-w-[68ch] text-fg-soft">{c.description}</span>
                  <span className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                    <span>
                      <span className="block text-fg-soft">Scope</span>
                      <span className="block text-fg">{c.impactScope}</span>
                    </span>
                    <span>
                      <span className="block text-fg-soft">Time</span>
                      <span className="block text-fg">{c.impactTime}</span>
                    </span>
                    <span>
                      <span className="block text-fg-soft">Risk</span>
                      <span className="block text-fg">{c.impactRisk}</span>
                    </span>
                  </span>
                </span>
              </Radio>
            ))}
          </div>
          <Radio value={CUSTOM} className="mt-4 text-fg-soft">
            None of these. Answer in my own words.
          </Radio>
        </RadioGroup>
      ) : (
        <fieldset>
          <legend className="text-lg font-semibold">Your answer</legend>
          <input type="hidden" name="choice" value={CUSTOM} />
        </fieldset>
      )}
      {selected === CUSTOM && (
        <textarea
          name="customAnswer"
          required
          rows={3}
          aria-label="Your answer"
          placeholder="What should the team do?"
          className="mt-3 w-full max-w-[72ch] rounded-tile bg-surface ring-1 ring-inset ring-line p-3 text-fg"
        />
      )}

      <label className="mt-6 block max-w-[72ch]">
        <span className="text-sm text-fg-soft">Why? (optional, saved in the Decision Log)</span>
        <textarea
          name="rationale"
          rows={2}
          className="mt-1 w-full rounded-tile bg-surface ring-1 ring-inset ring-line p-3 text-fg"
        />
      </label>

      {state.error && (
        <p role="alert" className="mt-4 text-lacquer">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !selected}
        className="mt-6 rounded-full bg-ink px-5 py-2.5 font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitLabel}
      </button>
      {pending && (
        <p className="mt-2 text-sm text-fg-soft">
          Drafting the Spec change. This can take a few seconds.
        </p>
      )}
    </form>
  );
}
