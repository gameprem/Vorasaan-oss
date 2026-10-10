'use client';

import type { ConversationCompactionSummary, ConversationCompactionView } from '@vorasaan/shared';
import { useState } from 'react';
import { getJson } from '@/lib/chat-client';
import { Dialog } from '../ui/dialog';
import { SkeletonText } from '../ui/skeleton';

// Where a Conversation was compacted (ticket 0066, ADR 0012): a thin divider. Everything
// above it stays here to read; the AI reads it only through the Conversation Summary.
// "View summary" shows that summary as this compaction left it. It is read-only: the
// person steers it with /compact and what to keep, and records what matters in the Spec
// or the Brief, the source of truth (ADR 0001).

const TRIGGER = {
  AUTO: 'Compacted automatically',
  MANUAL: 'Compacted',
  TOO_LONG: 'Compacted when the model said the chat was too long',
} as const;

export function CompactionDivider({
  conversationId,
  compaction,
}: {
  conversationId: string;
  compaction: ConversationCompactionView;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<ConversationCompactionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = async () => {
    setOpen(true);
    if (summary) return;
    setError(null);
    const res = await getJson<ConversationCompactionSummary>(
      `/api/conversations/${conversationId}/compactions/${compaction.id}`,
    );
    if (res.ok) setSummary(res.data);
    else setError(res.message);
  };

  const when = new Date(compaction.createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <>
      <div className="compaction-divider" data-compaction={compaction.number}>
        <span className="text">
          <span>↑ The AI reads the messages above as a summary</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={show}>
            View summary
          </button>
        </span>
      </div>
      <Dialog title="Conversation Summary" isOpen={open} onOpenChange={setOpen}>
        <p className="mb-3 text-sm text-fg-soft">
          {compaction.createdBy
            ? `${TRIGGER.MANUAL} by ${compaction.createdBy.name}`
            : TRIGGER[compaction.trigger]}
          , {when}
          {compaction.focus ? ` · keeping “${compaction.focus}”` : ''}
          {summary && !summary.current ? ' · a later compaction replaced it' : ''}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-lacquer">
            {error}
          </p>
        ) : !summary ? (
          <div role="status" aria-label="Loading the summary">
            <SkeletonText lines={5} />
          </div>
        ) : (
          <div className="summary-sections">
            {summary.sections.map((s) => (
              <section key={s.heading}>
                <h3>{s.heading}</h3>
                {s.items.length ? (
                  <ul>
                    {[...new Set(s.items)].map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-soft">None</p>
                )}
              </section>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
