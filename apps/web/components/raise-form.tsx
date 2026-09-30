'use client';

import type { DecisionRequestKind } from '@vorasaan/shared';
import { useActionState, useState } from 'react';
import { type RequestActionState, raiseRequest } from '@/lib/request-actions';
import { field, primaryButton } from './ui';

const KINDS: { kind: DecisionRequestKind; title: string; hint: string }[] = [
  { kind: 'BLOCKER', title: 'Blocker', hint: 'Your work stops until it is decided.' },
  { kind: 'QUESTION', title: 'Question', hint: 'You keep working meanwhile.' },
];

/** Raise a Decision Request on a Feature. The AI drafts Choices, then the Raiser reviews them. */
export function RaiseForm({ featureId }: { featureId: string }) {
  const [state, run, pending] = useActionState<RequestActionState, FormData>(
    raiseRequest.bind(null, featureId),
    {},
  );
  const [kind, setKind] = useState<DecisionRequestKind>('BLOCKER');
  const [plainText, setPlainText] = useState(false);
  // Controlled, so an error from the server keeps what was typed.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const withChoices = kind === 'BLOCKER' || !plainText;

  return (
    <form action={run} className="max-w-[72ch] space-y-6">
      <fieldset>
        <legend className="text-sm font-medium">What kind of request is it?</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {KINDS.map((k) => (
            <label
              key={k.kind}
              className={`flex cursor-pointer gap-3 rounded-lg border p-4 has-[:focus-visible]:outline-2 ${
                kind === k.kind ? 'border-ink bg-sheet' : 'border-rule'
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={k.kind}
                checked={kind === k.kind}
                onChange={() => setKind(k.kind)}
                className="mt-1 accent-jade"
              />
              <span>
                <span className="block font-medium">{k.title}</span>
                <span className="block text-sm text-ink-soft">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="text-sm font-medium">Title</span>
        <input
          name="title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Should a failed payment keep the cart?"
          className={field}
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Description</span>
        <textarea
          name="description"
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder="What you found, what it blocks, and what you need decided."
          className={field}
        />
      </label>

      {kind === 'QUESTION' && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="plainText"
            checked={plainText}
            onChange={(e) => setPlainText(e.target.checked)}
            className="mt-1 accent-jade"
          />
          <span>
            Ask as plain text, without Choices
            <span className="block text-sm text-ink-soft">
              The Decider answers in their own words.
            </span>
          </span>
        </label>
      )}

      {state.error && (
        <p role="alert" className="text-seal">
          {state.error}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? (withChoices ? 'Drafting Choices…' : 'Saving…') : 'Continue to review'}
        </button>
        <p className="mt-2 text-sm text-ink-soft">
          {withChoices
            ? 'The AI drafts two to four Choices and suggests who decides. You review them before anything is sent.'
            : 'You pick who decides before anything is sent.'}
        </p>
      </div>
    </form>
  );
}
