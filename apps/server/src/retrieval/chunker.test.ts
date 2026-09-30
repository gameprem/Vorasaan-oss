import { describe, expect, test } from 'bun:test';
import { CHUNKING, chunkMarkdown, estimateTokens } from './chunker.ts';

const words = (n: number, word = 'lorem') =>
  Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

describe('chunkMarkdown', () => {
  test('empty or blank text has no chunks', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('  \n\n \t')).toEqual([]);
  });

  test('a short document is one chunk, numbered from 0, with its token estimate', () => {
    const chunks = chunkMarkdown('# Title\n\nHello world.');
    expect(chunks).toEqual([
      {
        position: 0,
        text: '# Title\n\nHello world.',
        tokenCount: estimateTokens('# Title\n\nHello world.'),
      },
    ]);
  });

  test('small sections are packed together up to the target size', () => {
    const md = '# A\none\n\n## B\ntwo\n\n## C\nthree';
    expect(chunkMarkdown(md).map((c) => c.text)).toEqual([md]);
  });

  test('splits at headings: a section never shares a chunk when it would pass the target', () => {
    const a = `## Payments\n${words(60, 'pay')}`;
    const b = `## Refunds\n${words(60, 'refund')}`;
    const chunks = chunkMarkdown(`${a}\n\n${b}`, { targetTokens: 150, overlapTokens: 20 });
    expect(chunks.map((c) => c.text)).toEqual([a, b]);
  });

  test('headings inside fenced code blocks do not start a section', () => {
    const md = '## Setup\n```sh\n# not a heading\necho hi\n```\nafter';
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(md);
  });

  test('a long section is split by paragraph, each piece keeps its heading, and pieces overlap', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => words(40, `p${i}w`));
    const md = `## Long section\n\n${paragraphs.join('\n\n')}`;
    const chunks = chunkMarkdown(md, { targetTokens: 200, overlapTokens: 30 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('## Long section\n')).toBe(true);
      expect(chunk.tokenCount).toBeLessThanOrEqual(200);
    }
    // Every paragraph is somewhere, whole.
    for (const p of paragraphs) expect(chunks.some((c) => c.text.includes(p))).toBe(true);
    // The start of each later chunk repeats the end of the one before it.
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]?.text ?? '';
      const body = (chunks[i]?.text ?? '').slice('## Long section\n'.length);
      const firstWords = body.split(/\s+/).slice(0, 3).join(' ');
      expect(previous).toContain(firstWords);
    }
  });

  test('text without headings or paragraphs is hard-split at word boundaries', () => {
    const text = words(1_000);
    const chunks = chunkMarkdown(text, { targetTokens: 100, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      // No word is cut in half.
      for (const w of chunk.text.split(/\s+/)) expect(w).toMatch(/^lorem\d+$/);
    }
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    expect(chunks.at(-1)?.text.endsWith('lorem999')).toBe(true);
  });

  test('defaults are about 400 tokens with 50 of overlap', () => {
    expect(CHUNKING).toEqual({ targetTokens: 400, overlapTokens: 50 });
    const chunks = chunkMarkdown(words(3_000));
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(400);
  });

  test('normalizes Windows line endings', () => {
    expect(chunkMarkdown('# A\r\n\r\nb')[0]?.text).toBe('# A\n\nb');
  });
});
