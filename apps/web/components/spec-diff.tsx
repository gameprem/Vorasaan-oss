import type { SpecDiff as SpecDiffView } from '@vorasaan/shared';
import { diffLines } from 'diff';

type Kind = 'add' | 'del' | 'same';
type Row = { kind: Kind | 'fold'; text: string };

const CONTEXT = 3;

/** Folds long unchanged runs, keeping CONTEXT lines next to each change. */
function fold(lines: { kind: Kind; text: string }[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as { kind: Kind; text: string };
    if (line.kind !== 'same') {
      rows.push(line);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end]?.kind === 'same') end++;
    const run = lines.slice(i, end);
    const head = i === 0 ? [] : run.slice(0, CONTEXT);
    const tail = end === lines.length ? [] : run.slice(-CONTEXT);
    if (run.length <= head.length + tail.length + 1) rows.push(...run);
    else {
      rows.push(...head, {
        kind: 'fold',
        text: `${run.length - head.length - tail.length} unchanged lines`,
      });
      rows.push(...tail);
    }
    i = end;
  }
  return rows;
}

function DiffTable({ rows, caption }: { rows: Row[]; caption?: string }) {
  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;
  return (
    <figure className="overflow-hidden rounded-xl border border-rule bg-sheet">
      <figcaption className="border-b border-rule px-4 py-2 text-sm text-ink-soft">
        {caption && <span className="mr-2 font-medium text-ink">{caption}:</span>}
        <span className="text-jade">{added} added</span>,{' '}
        <span className="text-seal">{removed} removed</span>
      </figcaption>
      <pre className="overflow-x-auto py-2 font-mono text-[13px] leading-6">
        {rows.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for a given diff
            key={i}
            className={
              row.kind === 'add'
                ? 'bg-jade-wash px-4 text-jade'
                : row.kind === 'del'
                  ? 'bg-seal-wash px-4 text-seal line-through decoration-seal/40'
                  : row.kind === 'fold'
                    ? 'px-4 text-ink-soft/70 italic'
                    : 'px-4 text-ink-soft'
            }
          >
            <span aria-hidden className="mr-3 inline-block w-3 select-none">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </span>
            <span className="sr-only">
              {row.kind === 'add' ? 'Added: ' : row.kind === 'del' ? 'Removed: ' : ''}
            </span>
            {row.text || ' '}
          </div>
        ))}
      </pre>
    </figure>
  );
}

/** Unified line diff of two Markdown documents, with unchanged runs folded. */
export function SpecDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, '')
      .split('\n')
      .map((text) => ({
        kind: (part.added ? 'add' : part.removed ? 'del' : 'same') as Kind,
        text,
      })),
  );
  return <DiffTable rows={fold(lines)} />;
}

const KIND: Record<SpecDiffView['lines'][number]['kind'], Kind> = {
  ADDED: 'add',
  REMOVED: 'del',
  UNCHANGED: 'same',
};

/** A diff between two Spec Versions as computed by the server (`GET /features/:id/spec-diff`). */
export function VersionDiff({ diff }: { diff: SpecDiffView }) {
  const rows = fold(diff.lines.map((l) => ({ kind: KIND[l.kind], text: l.text })));
  return (
    <DiffTable
      rows={rows}
      caption={diff.from === 0 ? `v${diff.to}` : `v${diff.from} → v${diff.to}`}
    />
  );
}
