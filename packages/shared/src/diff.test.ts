import { describe, expect, test } from 'bun:test';
import { diffLines } from './diff.ts';

/** Renders a diff as unified-style lines for compact assertions. */
const render = (from: string, to: string) =>
  diffLines(from, to).map(
    (l) => `${{ UNCHANGED: ' ', ADDED: '+', REMOVED: '-' }[l.kind]}${l.text}`,
  );

describe('diffLines', () => {
  test('identical texts are all unchanged', () => {
    expect(render('a\nb\n', 'a\nb\n')).toEqual([' a', ' b']);
  });

  test('lists added and removed lines, removals first', () => {
    expect(render('# Goal\nold\nkeep\n', '# Goal\nnew\nkeep\nextra\n')).toEqual([
      ' # Goal',
      '-old',
      '+new',
      ' keep',
      '+extra',
    ]);
  });

  test('keeps the longest common run in the middle of a change', () => {
    expect(render('a\nx\nb\ny\nc\n', 'a\nb\nz\nc\n')).toEqual([' a', '-x', ' b', '-y', '+z', ' c']);
  });

  test('an empty side is all additions or all removals', () => {
    expect(render('', 'a\nb\n')).toEqual(['+a', '+b']);
    expect(render('a\n', '')).toEqual(['-a']);
  });

  test('numbers lines on each side', () => {
    expect(diffLines('a\nb\n', 'b\nc\n')).toEqual([
      { kind: 'REMOVED', text: 'a', fromLine: 1, toLine: null },
      { kind: 'UNCHANGED', text: 'b', fromLine: 2, toLine: 1 },
      { kind: 'ADDED', text: 'c', fromLine: null, toLine: 2 },
    ]);
  });

  test('ignores line-ending differences and a missing final newline', () => {
    expect(render('a\r\nb', 'a\nb\n')).toEqual([' a', ' b']);
  });

  test('blank lines are real lines', () => {
    expect(render('a\n\nb\n', 'a\nb\n')).toEqual([' a', '-', ' b']);
  });
});
