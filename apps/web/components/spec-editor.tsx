'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { writeSpec } from '@/lib/org-actions';
import { field, primaryButton, secondaryButton } from './ui';

const TEMPLATE = `# Feature title

## Goal
What problem this solves, for whom.

## User flow
1. …

## Acceptance criteria
- [ ] …

## Out of scope
- …

## Open questions
- …
`;

/** Markdown Spec editor with a preview. Saving creates the next Spec Version. */
export function SpecEditor({
  featureId,
  current,
  baseVersion,
  onClose,
}: {
  featureId: string;
  current: string | null;
  baseVersion: number;
  onClose?: () => void;
}) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(current ?? TEMPLATE);
  const [summary, setSummary] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  return (
    <div>
      <div className="flex gap-4 text-sm" role="tablist">
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={tab === t ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'}
          >
            {t === 'write' ? 'Write' : 'Preview'}
          </button>
        ))}
      </div>
      {tab === 'write' ? (
        <textarea
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          rows={22}
          aria-label="Spec in Markdown"
          className={`${field} font-mono text-sm leading-6`}
        />
      ) : (
        <div className="spec mt-1 min-h-40 rounded-xl border border-rule bg-sheet p-6">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
      )}
      <label className="mt-4 block max-w-xl">
        <span className="text-sm">What changed? (optional, shown in Version history)</span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className={field} />
      </label>
      {error && (
        <p role="alert" className="mt-3 text-seal">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          disabled={pending || !markdown.trim()}
          className={primaryButton}
          onClick={() =>
            start(async () => {
              setError(undefined);
              const result = await writeSpec(featureId, {
                markdown,
                summary: summary || undefined,
                baseVersion,
              });
              if (result.error) setError(result.error);
              else {
                onClose?.();
                router.refresh();
              }
            })
          }
        >
          {pending ? 'Saving…' : `Save as v${baseVersion + 1}`}
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
