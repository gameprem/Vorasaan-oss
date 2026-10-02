import { describe, expect, test } from 'bun:test';
import { CONTEXT_TRUNCATION_MARKER } from '../attachments/attachment-context.ts';
import { clipToTokens, estimateTokens } from './token-estimate.ts';
import fixture from './token-fixture.counts.json';
import {
  ENGLISH_SAMPLES,
  MIXED_SAMPLES,
  THAI_SAMPLES,
  TOKEN_SAMPLES,
  type TokenSample,
} from './token-fixture.ts';

const counts: Record<string, { chars: number; tokens: number }> = fixture.counts;

/** The real token count of a fixture text, from the checked-in counts. */
const real = (sample: TokenSample) => counts[sample.id]?.tokens ?? Number.NaN;
const error = (estimate: number, actual: number) => (estimate - actual) / actual;
/** The estimate before ticket 0059: one token per four characters, whatever the script. */
const oldEstimate = (text: string) => Math.ceil(text.length / 4);

describe('the token fixture', () => {
  test('every text has a checked-in count from the real tokenizer, for this exact text', () => {
    for (const sample of TOKEN_SAMPLES) {
      // A stale count (text edited, counts not regenerated) fails here.
      expect({ id: sample.id, chars: counts[sample.id]?.chars }).toEqual({
        id: sample.id,
        chars: sample.text.length,
      });
      expect(real(sample)).toBeGreaterThan(0);
    }
  });

  test('the old estimate undercounted Thai at least twofold', () => {
    for (const sample of THAI_SAMPLES) {
      expect(oldEstimate(sample.text)).toBeLessThan(real(sample) / 2);
    }
  });
});

describe('estimateTokens', () => {
  test('a Thai paragraph is within ±25% of its real token count, and never under it', () => {
    for (const sample of [...THAI_SAMPLES, ...MIXED_SAMPLES]) {
      const estimate = estimateTokens(sample.text);
      expect({ id: sample.id, ok: Math.abs(error(estimate, real(sample))) <= 0.25 }).toEqual({
        id: sample.id,
        ok: true,
      });
      // Never under the real count, so a budget filled with Thai holds.
      expect(estimate).toBeGreaterThanOrEqual(real(sample));
    }
  });

  test('English estimates are unchanged within ±5%', () => {
    for (const sample of ENGLISH_SAMPLES) {
      const before = oldEstimate(sample.text);
      expect(Math.abs(error(estimateTokens(sample.text), before))).toBeLessThanOrEqual(0.05);
    }
    // Text without Thai is counted exactly as before.
    for (const text of ['', 'a', 'abcd', 'abcde', 'Hello, world!\n\n- one\n- two', 'ü'.repeat(9)]) {
      expect(estimateTokens(text)).toBe(oldEstimate(text));
    }
  });

  test('counts each script at its own rate', () => {
    // 6 Thai characters at 0.95 per token: 6.3, rounded up.
    expect(estimateTokens('สวัสดี')).toBe(7);
    expect(estimateTokens('สวัสดี abcd')).toBe(8);
    expect(estimateTokens('ก'.repeat(950) + 'x'.repeat(1_000))).toBe(1_250);
  });
});

describe('clipToTokens', () => {
  test('keeps text that fits, whole', () => {
    expect(clipToTokens('สวัสดีครับ', 11)).toBe('สวัสดีครับ');
    expect(clipToTokens('abcd'.repeat(10), 10)).toBe('abcd'.repeat(10));
  });

  test('shortens Thai to its token budget, marker included, keeping the start', () => {
    for (const sample of THAI_SAMPLES) {
      const max = Math.floor(estimateTokens(sample.text) / 2);
      const clipped = clipToTokens(sample.text, max);
      expect(estimateTokens(clipped)).toBeLessThanOrEqual(max);
      expect(clipped.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
      const kept = clipped.slice(0, -CONTEXT_TRUNCATION_MARKER.length);
      expect(sample.text.startsWith(kept)).toBe(true);
      // It uses the room it has: no more than a few characters are left unused.
      expect(estimateTokens(clipped)).toBeGreaterThan(max - 3);
    }
  });

  test('English is shortened at four characters per token, as before', () => {
    const text = 'x'.repeat(1_000);
    expect(clipToTokens(text, 100)).toHaveLength(400);
    expect(clipToTokens(text, 5)).toBe('x'.repeat(20));
    expect(clipToTokens(text, 0)).toBe('');
  });
});
