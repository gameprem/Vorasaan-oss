'use client';

import type { DecisionRequestKind } from '@vorasaan/shared';
import { useActionState, useState } from 'react';
import { type RequestActionState, raiseRequest } from '@/lib/request-actions';
import { field, primaryButton } from './ui';
import { Checkbox } from './ui/checkbox';
import { Radio, RadioGroup } from './ui/radio-group';

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
      <RadioGroup
        label="What kind of request is it?"
        labelClassName="text-sm font-medium"
        name="kind"
        value={kind}
        onChange={(k) => setKind(k as DecisionRequestKind)}
      >
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {KINDS.map((k) => (
            <Radio key={k.kind} value={k.kind} variant="card" description={k.hint}>
              <span className="font-medium">{k.title}</span>
            </Radio>
          ))}
        </div>
      </RadioGroup>

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
        <Checkbox
          name="plainText"
          isSelected={plainText}
          onChange={setPlainText}
          description="The Decider answers in their own words."
        >
          Ask as plain text, without Choices
        </Checkbox>
      )}

      {state.error && (
        <p role="alert" className="text-lacquer">
          {state.error}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? (withChoices ? 'Drafting Choices…' : 'Saving…') : 'Continue to review'}
        </button>
        <p className="mt-2 text-sm text-fg-soft">
          {withChoices
            ? 'The AI drafts two to four Choices and suggests who decides. You review them before anything is sent.'
            : 'You pick who decides before anything is sent.'}
        </p>
      </div>
    </form>
  );
}
