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
    <figure className="overflow-hidden rounded-card bg-rail">
      <figcaption className="border-b-2 border-bg px-4 py-2 text-sm text-fg-soft">
        {caption && <span className="mr-2 font-medium text-fg">{caption}:</span>}
        <span className="text-jade">{added} added</span>,{' '}
        <span className="text-lacquer">{removed} removed</span>
      </figcaption>
      <pre className="overflow-x-auto py-2 font-mono text-[13px] leading-6">
        {rows.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for a given diff
            key={i}
            className={
              row.kind === 'add'
                ? 'bg-jade-wash px-4 text-fg'
                : row.kind === 'del'
                  ? 'bg-lacquer-wash px-4 text-fg line-through decoration-lacquer/60'
                  : row.kind === 'fold'
                    ? 'px-4 text-fg-soft/70 italic'
                    : 'px-4 text-fg-soft'
            }
          >
            <span
              aria-hidden
              className={`mr-3 inline-block w-3 select-none ${
                row.kind === 'add' ? 'text-jade' : row.kind === 'del' ? 'text-lacquer' : ''
              }`}
            >
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

/**
 * A diff between two versions as computed by the server: Spec Versions
 * (`GET /features/:id/spec-diff`), or Prompt Versions with their own `caption` (0071).
 */
export function VersionDiff({
  diff,
  caption,
}: {
  diff: Pick<SpecDiffView, 'from' | 'to' | 'lines'>;
  caption?: string;
}) {
  const rows = fold(diff.lines.map((l) => ({ kind: KIND[l.kind], text: l.text })));
  return (
    <DiffTable
      rows={rows}
      caption={caption ?? (diff.from === 0 ? `v${diff.to}` : `v${diff.from} → v${diff.to}`)}
    />
  );
}
