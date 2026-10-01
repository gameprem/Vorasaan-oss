import type { SpecDiffLine } from './spec.ts';

/**
 * Above this many LCS cells (after trimming the common head and tail) we skip
 * the table and show the changed block as removed-then-added. Still correct,
 * just not minimal; it keeps a pathological pair of Specs from eating memory.
 */
const MAX_LCS_CELLS = 4_000_000;

type Op = 'UNCHANGED' | 'ADDED' | 'REMOVED';

/** Splits Markdown into lines; a final newline does not start an extra empty line. */
function toLines(markdown: string): string[] {
  if (markdown === '') return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence edit script for the middle block `a` → `b`. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...Array<Op>(n).fill('REMOVED'), ...Array<Op>(m).fill('ADDED')];
  }

  // lcs[i * (m + 1) + j] = LCS length of a[i..] and b[j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  // Walking forward and preferring removals puts "-" lines before "+" lines.
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('UNCHANGED');
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push('REMOVED');
      i++;
    } else {
      ops.push('ADDED');
      j++;
    }
  }
  while (i++ < n) ops.push('REMOVED');
  while (j++ < m) ops.push('ADDED');
  return ops;
}

/** A line diff of two Markdown texts (Spec or Project Brief), in reading order. Shared so the server and the CLI render the same diff. */
export function diffLines(from: string, to: string): SpecDiffLine[] {
  const a = toLines(from);
  const b = toLines(to);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }

  const ops: Op[] = [
    ...Array<Op>(head).fill('UNCHANGED'),
    ...lcsOps(a.slice(head, tailA), b.slice(head, tailB)),
    ...Array<Op>(a.length - tailA).fill('UNCHANGED'),
  ];

  const lines: SpecDiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const kind of ops) {
    if (kind === 'UNCHANGED') {
      lines.push({ kind, text: a[i] ?? '', fromLine: i + 1, toLine: j + 1 });
      i++;
      j++;
    } else if (kind === 'REMOVED') {
      lines.push({ kind, text: a[i] ?? '', fromLine: i + 1, toLine: null });
      i++;
    } else {
      lines.push({ kind, text: b[j] ?? '', fromLine: null, toLine: j + 1 });
      j++;
    }
  }
  return lines;
}
