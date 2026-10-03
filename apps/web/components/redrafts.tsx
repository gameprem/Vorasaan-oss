'use client';

import type {
  ProposalKind,
  ProposalRedraftsView,
  RedraftView,
  RequestChangesInput,
} from '@vorasaan/shared';
import { MAX_FEEDBACK_CHARS } from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { type PostResult, postJson } from '@/lib/chat-client';
import { type PointerOption, redraftRoute } from '@/lib/redrafts';
import { SpecDiff } from './spec-diff';
import { field, primaryButton, secondaryButton } from './ui';

// Request changes and Redrafts (ADR 0013, ticket 0065): the third answer to an AI proposal,
// next to Approve and Decline. The person says what to change, optionally pointing at one
// part, and the AI writes the next Redraft of the same proposal. Earlier Redrafts stay,
// each with the feedback that caused it, and any two can be compared.

/**
 * The Request changes button and, once pressed, its form: what to change (required) and,
 * optionally, which part. `send` makes the call; while the AI writes, the form says so.
 */
export function RequestChanges({
  send,
  pointers = [],
  left,
  disabled = false,
  buttonClassName = secondaryButton,
  onSent,
}: {
  send: (input: RequestChangesInput) => Promise<PostResult<unknown>>;
  pointers?: PointerOption[];
  /** How many Request changes are left; none: the button explains why it is off. */
  left?: number;
  disabled?: boolean;
  buttonClassName?: string;
  onSent?: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [about, setAbout] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exhausted = left === 0;

  if (!open) {
    return (
      <button
        type="button"
        className={buttonClassName}
        disabled={disabled || exhausted}
        title={exhausted ? 'It was redrafted as many times as allowed' : undefined}
        onClick={() => setOpen(true)}
      >
        Request changes
      </button>
    );
  }

  const submit = async () => {
    const text = feedback.trim();
    if (!text) {
      setError('Say what the AI should change.');
      return;
    }
    const pointer = pointers.find((p) => p.label === about)?.pointer;
    setBusy(true);
    setError(null);
    const res = await send({ feedback: text, ...(pointer ? { pointer } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOpen(false);
    setFeedback('');
    setAbout('');
    onSent?.();
  };

  return (
    <form
      aria-label="Request changes"
      className="w-full space-y-3 rounded-card bg-rail p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <label htmlFor={`${id}-feedback`} className="text-sm font-medium">
          What should the AI change?
        </label>
        <textarea
          id={`${id}-feedback`}
          className={field}
          rows={3}
          maxLength={MAX_FEEDBACK_CHARS}
          value={feedback}
          disabled={busy}
          placeholder="E.g. “Choice B should keep the old flow” or “answer in Thai, shorter”"
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) setOpen(false);
          }}
          // biome-ignore lint/a11y/noAutofocus: the field the Request changes button just opened
          autoFocus
        />
      </div>
      {pointers.length > 0 && (
        <div>
          <label htmlFor={`${id}-about`} className="text-sm font-medium">
            About
          </label>
          <select
            id={`${id}-about`}
            className={field}
            value={about}
            disabled={busy}
            onChange={(e) => setAbout(e.target.value)}
          >
            <option value="">The whole proposal</option>
            {pointers.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-lacquer">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? 'Writing the Redraft…' : 'Ask for a Redraft'}
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <span className="text-sm text-fg-soft" role="status">
          {busy
            ? 'The AI is writing the Redraft. Nothing changes until someone approves it.'
            : left !== undefined
              ? `${left} Request changes left`
              : ''}
        </span>
      </div>
    </form>
  );
}

const PERSON = (r: RedraftView) => r.requestedBy?.name ?? 'Someone';

function pointerText(r: RedraftView): string {
  const p = r.pointer;
  if (!p) return '';
  if (p.kind === 'CHOICE') return ` about Choice ${p.label}`;
  if (p.kind === 'SECTION') return ` about the section “${p.heading}”`;
  return p.from === p.to ? ` about line ${p.from}` : ` about lines ${p.from}–${p.to}`;
}

/**
 * Every Redraft of a proposal: a switcher, the feedback that caused the one picked, and a
 * diff from any other (the one before it, by default), the way Spec Versions are compared.
 */
export function RedraftHistory({
  redrafts,
  initial,
}: {
  redrafts: ProposalRedraftsView;
  /** The Redraft to show first (`?redraft=N` from a chat app link); else the current one. */
  initial?: number;
}) {
  const ready = redrafts.redrafts.filter((r) => r.status === 'READY');
  const pick = (n: number | undefined) => ready.find((r) => r.number === n)?.number;
  const [selected, setSelected] = useState(pick(initial) ?? redrafts.current);
  const [from, setFrom] = useState(Math.max(1, selected - 1));
  const id = useId();

  // A new Redraft arrived: show it.
  useEffect(() => {
    setSelected(redrafts.current);
    setFrom(Math.max(1, redrafts.current - 1));
  }, [redrafts.current]);

  if (ready.length < 2 && !redrafts.writing) return null;
  const shown = ready.find((r) => r.number === selected) ?? ready.at(-1);
  const base = ready.find((r) => r.number === from) ?? ready[0];

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <h3 id={`${id}-h`} className="text-base font-semibold">
        Redrafts
      </h3>
      <fieldset aria-label="Redrafts" className="flex flex-wrap gap-2">
        {ready.map((r) => (
          <button
            key={r.number}
            type="button"
            aria-pressed={r.number === shown?.number}
            onClick={() => {
              setSelected(r.number);
              setFrom(Math.max(1, r.number - 1));
            }}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              r.number === shown?.number ? 'bg-ink text-on-ink' : 'bg-surface text-fg'
            }`}
          >
            Redraft {r.number}
            {r.number === redrafts.current ? ' (current)' : ''}
          </button>
        ))}
        {redrafts.writing && (
          <span className="rounded-full bg-saffron-wash px-3 py-1 text-sm" role="status">
            Writing Redraft {redrafts.redrafts.at(-1)?.number ?? 1}…
          </span>
        )}
      </fieldset>
      {shown && (
        <div className="space-y-2 text-sm">
          {shown.feedback ? (
            <p>
              <span className="font-medium">{PERSON(shown)}</span> asked{pointerText(shown)}:{' '}
              <q className="whitespace-pre-line">{shown.feedback}</q>
            </p>
          ) : (
            <p className="text-fg-soft">The proposal as the AI first drafted it.</p>
          )}
          {shown.summary && <p className="text-fg-soft">The AI: {shown.summary}</p>}
          {shown.draftedWith && (
            <p className="text-fg-soft">
              Written with {shown.draftedWith.displayName ?? shown.draftedWith.modelId}
            </p>
          )}
          {ready.length > 1 && base && (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${id}-from`}>Compare Redraft {shown.number} with</label>
                <select
                  id={`${id}-from`}
                  className="rounded-tile bg-surface px-2 py-1 ring-1 ring-inset ring-line"
                  value={from}
                  onChange={(e) => setFrom(Number(e.target.value))}
                >
                  {ready
                    .filter((r) => r.number !== shown.number)
                    .map((r) => (
                      <option key={r.number} value={r.number}>
                        Redraft {r.number}
                      </option>
                    ))}
                </select>
              </p>
              {base.number !== shown.number && (
                <figure
                  aria-label={`Changes from Redraft ${base.number} to Redraft ${shown.number}`}
                >
                  <SpecDiff before={base.text} after={shown.text} />
                </figure>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A proposal page's Redrafts and Request changes, for a proposal reviewed outside a
 * Conversation (its own page, a Decision Request, the Project page). After a Redraft the
 * page re-renders with it; another viewer's page does too, through `proposal.redrafted`.
 */
export function ProposalRedrafts({
  kind,
  proposalId,
  redrafts,
  pointers,
  initial,
}: {
  kind: ProposalKind;
  proposalId: string;
  redrafts: ProposalRedraftsView;
  pointers?: PointerOption[];
  initial?: number;
}) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <RedraftHistory redrafts={redrafts} initial={initial} />
      {redrafts.canRequestChanges ? (
        <RequestChanges
          send={(input) => postJson(redraftRoute(kind, proposalId), input)}
          pointers={pointers}
          left={redrafts.left}
          onSent={() => router.refresh()}
        />
      ) : (
        redrafts.left === 0 &&
        redrafts.limit > 0 && (
          <p className="text-sm text-fg-soft">
            Redrafted {redrafts.limit} times, the most allowed: approve it, decline it, or edit it
            by hand.
          </p>
        )
      )}
    </div>
  );
}

/** A proposal's Redrafts, fetched when first shown (an Action Card loads them on demand). */
export function useRedrafts(kind: ProposalKind, proposalId: string, version: number | string) {
  const [redrafts, setRedrafts] = useState<ProposalRedraftsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` refetches after a Redraft
  useEffect(() => {
    let live = true;
    fetch(redraftRoute(kind, proposalId))
      .then(async (res) => {
        const body = await res.json();
        if (!live) return;
        if (res.ok) setRedrafts(body as ProposalRedraftsView);
        else setError((body as { message?: string }).message ?? 'Could not load the Redrafts');
      })
      .catch(() => live && setError('Could not load the Redrafts'));
    return () => {
      live = false;
    };
  }, [kind, proposalId, version]);
  return { redrafts, error };
}
