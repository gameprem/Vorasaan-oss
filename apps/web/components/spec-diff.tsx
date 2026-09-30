import { diffLines } from 'diff';

/** Unified line diff of two Markdown documents, with unchanged runs folded. */
export function SpecDiff({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  const CONTEXT = 3;

  const rows: { kind: 'add' | 'del' | 'same' | 'fold'; text: string }[] = [];
  parts.forEach((part, index) => {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.added || part.removed) {
      for (const text of lines) rows.push({ kind: part.added ? 'add' : 'del', text });
      return;
    }
    const isFirst = index === 0;
    const isLast = index === parts.length - 1;
    const head = isFirst ? [] : lines.slice(0, CONTEXT);
    const tail = isLast ? [] : lines.slice(-CONTEXT);
    if (lines.length <= head.length + tail.length + 1) {
      for (const text of lines) rows.push({ kind: 'same', text });
      return;
    }
    for (const text of head) rows.push({ kind: 'same', text });
    rows.push({
      kind: 'fold',
      text: `${lines.length - head.length - tail.length} unchanged lines`,
    });
    for (const text of tail) rows.push({ kind: 'same', text });
  });

  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;

  return (
    <figure className="overflow-hidden rounded-xl border border-rule bg-sheet">
      <figcaption className="border-b border-rule px-4 py-2 text-sm text-ink-soft">
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
