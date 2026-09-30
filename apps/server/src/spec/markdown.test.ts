import { describe, expect, test } from 'bun:test';
import { normalizeMarkdown } from './markdown.ts';

describe('normalizeMarkdown', () => {
  test('ends with exactly one newline and uses LF', () => {
    expect(normalizeMarkdown('# A\r\n\r\ntext')).toBe('# A\n\ntext\n');
    expect(normalizeMarkdown('# A\n\n\n')).toBe('# A\n');
    expect(normalizeMarkdown('# A')).toBe('# A\n');
  });

  test('is idempotent', () => {
    const once = normalizeMarkdown('# A\n- b  \n');
    expect(normalizeMarkdown(once)).toBe(once);
  });
});
