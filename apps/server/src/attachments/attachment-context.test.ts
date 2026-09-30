import { describe, expect, test } from 'bun:test';
import { CONTEXT_TRUNCATION_MARKER, clipForAi } from './attachment-context.ts';

describe('clipForAi', () => {
  test('keeps short text and cuts long text to the limit, marker included', () => {
    expect(clipForAi('abc', 10)).toBe('abc');
    const clipped = clipForAi('x'.repeat(1000), 500);
    expect(clipped).toHaveLength(500);
    expect(clipped.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  test('never returns more than the limit, even one shorter than the marker', () => {
    expect(clipForAi('x'.repeat(100), 10)).toBe('x'.repeat(10));
  });
});
