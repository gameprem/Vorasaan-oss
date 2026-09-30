import { describe, expect, test } from 'bun:test';
import type { AttachmentForAi } from '../ai/ai.port.ts';
import { CONTEXT_TRUNCATION_MARKER, clipForAi, fitToBudget } from './attachment-context.ts';

const att = (title: string, length: number): AttachmentForAi => ({
  title,
  source: 'FILE',
  text: title[0]?.repeat(length) ?? '',
});

const total = (list: AttachmentForAi[]) => list.reduce((n, a) => n + a.text.length, 0);

describe('clipForAi', () => {
  test('keeps short text and cuts long text to the limit, marker included', () => {
    expect(clipForAi('abc', 10)).toBe('abc');
    const clipped = clipForAi('x'.repeat(1000), 500);
    expect(clipped).toHaveLength(500);
    expect(clipped.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('fitToBudget', () => {
  test('keeps everything that fits, in order', () => {
    const fitted = fitToBudget([att('a', 100), att('b', 100)], 1000);
    expect(fitted.map((a) => a.title)).toEqual(['a', 'b']);
    expect(total(fitted)).toBe(200);
  });

  test('never exceeds the budget; the first Attachments win and the last one is cut', () => {
    const fitted = fitToBudget([att('a', 600), att('b', 600), att('c', 600)], 1000);
    expect(fitted.map((a) => a.title)).toEqual(['a', 'b']);
    expect(total(fitted)).toBe(1000);
    expect(fitted[1]?.text.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  test('drops Attachments once too little budget is left for a useful fragment', () => {
    const fitted = fitToBudget([att('a', 950), att('b', 600), att('c', 20)], 1000);
    expect(fitted.map((a) => a.title)).toEqual(['a']);
  });
});
