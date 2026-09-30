import type { DecisionRequestKind, DecisionRequestStatus } from '@vorasaan/shared';
import type { ReactNode } from 'react';

export function KindBadge({ kind }: { kind: DecisionRequestKind }) {
  return kind === 'BLOCKER' ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-seal-wash px-2.5 py-0.5 text-sm font-medium text-seal">
      <span aria-hidden className="size-1.5 rounded-full bg-seal" />
      Blocker
    </span>
  ) : (
    <span className="inline-flex rounded-full border border-rule px-2.5 py-0.5 text-sm text-ink-soft">
      Question
    </span>
  );
}

const STATUS_TEXT: Record<DecisionRequestStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Waiting for a decision',
  NEEDS_INFO: 'Waiting for more info',
  DECIDED: 'Decided, Spec change pending',
  SPEC_UPDATED: 'Decided and Spec updated',
  WITHDRAWN: 'Withdrawn',
};

export function statusText(status: DecisionRequestStatus) {
  return STATUS_TEXT[status];
}

/** Shown while any Blocker on a Feature is open (OPEN or NEEDS_INFO). Open Questions don't count. */
export function BlockedBadge({ openBlockers }: { openBlockers: number }) {
  if (openBlockers <= 0) return null;
  const count = `${openBlockers} open Blocker${openBlockers === 1 ? '' : 's'}`;
  return (
    <span
      title={count}
      className="inline-flex items-center rounded-full bg-seal px-2.5 py-0.5 text-sm font-medium text-sheet"
    >
      Blocked<span className="sr-only"> by {count}</span>
    </span>
  );
}

export function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function Notice({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'error';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'rounded-lg border border-seal/30 bg-seal-wash px-4 py-3 text-seal'
          : 'rounded-lg border border-rule bg-sheet px-4 py-3 text-ink-soft'
      }
    >
      {children}
    </div>
  );
}
