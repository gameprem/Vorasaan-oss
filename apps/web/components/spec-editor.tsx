'use client';

import { specTemplate } from '@vorasaan/shared';
import dynamic from 'next/dynamic';
import { useRef, useState, useTransition } from 'react';
import { field, primaryButton, secondaryButton } from './ui';

// BlockNote needs the browser, so it is loaded on the client only, in its own chunk.
const BlockEditor = dynamic(() => import('./block-editor'), {
  ssr: false,
  loading: () => (
    <p role="status" className="px-6 py-10 text-fg-soft">
      Loading the editor…
    </p>
  ),
});

const SPEC_TEMPLATE = specTemplate();

/**
 * The Markdown as stored: LF endings, one final newline (as the server normalizes it), and no
 * trailing spaces on a line outside code blocks. BlockNote writes hard breaks as a backslash,
 * so trailing spaces carry no meaning, but they don't survive re-opening either: without this,
 * saving an unchanged Spec could create a new version.
 */
function canonical(markdown: string) {
  let fence: string | null = null;
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (fence === null || marker.startsWith(fence))) {
        fence = fence === null ? marker : null;
        return line.trimEnd();
      }
      return fence === null ? line.trimEnd() : line;
    });
  return `${lines.join('\n').trimEnd()}\n`;
}

export type SaveMarkdownInput = { markdown: string; summary?: string; baseVersion: number };
type SaveResult = { error?: string; stale?: boolean };

/**
 * BlockNote editor for a versioned Markdown document: a Feature's Spec (the default) or a
 * Project Brief. `save` stores the Markdown as the next version on top of `baseVersion`; a
 * `stale` result (409) means someone saved first.
 */
export function SpecEditor({
  save: saveVersion,
  current,
  baseVersion,
  onClose,
  noun = 'Spec',
  template = SPEC_TEMPLATE,
}: {
  save: (input: SaveMarkdownInput) => Promise<SaveResult>;
  current: string | null;
  baseVersion: number;
  onClose?: () => void;
  noun?: string;
  /** What the editor starts from when there is no `current` version. */
  template?: string;
}) {
  const getMarkdown = useRef<(() => string) | null>(null);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<{ message: string; stale?: boolean }>();
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(undefined);
      const read = getMarkdown.current;
      if (!read) return setError({ message: 'The editor is still loading.' });
      const markdown = canonical(read());
      if (!markdown.trim()) return setError({ message: `The ${noun} is empty.` });
      if (current !== null && markdown === canonical(current)) {
        return setError({ message: `Nothing has changed since v${baseVersion}.` });
      }
      const result = await saveVersion({
        markdown,
        summary: summary.trim() || undefined,
        baseVersion,
      });
      if (result.error) setError({ message: result.error, stale: result.stale });
      // The action revalidates the page, so the new version arrives with its result.
      else onClose?.();
    });

  return (
    <div>
      <section aria-label={`${noun} editor`} className="min-h-60 rounded-card bg-rail py-4">
        <BlockEditor
          markdown={current ?? template}
          getMarkdown={getMarkdown}
          onChange={() => setError(undefined)}
        />
      </section>
      <p className="mt-2 text-sm text-fg-soft">
        Type <kbd>/</kbd> for headings, lists, tables and code. The {noun} is saved as Markdown, so
        colors, underline and text alignment are not kept.
      </p>
      <label className="mt-4 block max-w-xl">
        <span className="text-sm">What changed? (optional, shown in Version history)</span>
        <input
          value={summary}
          maxLength={200}
          onChange={(e) => setSummary(e.target.value)}
          className={field}
        />
      </label>
      {error && (
        <div role="alert" className="mt-3 text-lacquer">
          {error.message}{' '}
          {error.stale && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="font-medium underline underline-offset-2"
            >
              Reload the latest {noun}
            </button>
          )}
          {error.stale && (
            <span className="block text-sm">
              Copy anything you want to keep first: reloading discards these edits.
            </span>
          )}
        </div>
      )}
      <div className="mt-5 flex gap-3">
        <button type="button" disabled={pending} className={primaryButton} onClick={save}>
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
