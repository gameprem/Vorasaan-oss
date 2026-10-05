import { describe, expect, test } from 'bun:test';
import type { ContextBlock } from '../ai/ai.port.ts';
import { chunkMarkdown } from './chunker.ts';
import { MIN_REPEAT_CHARS, shown, unrepeated, withoutShown } from './context-dedupe.ts';

// Ticket 0076: one call never sends the same text twice.

const PARAGRAPHS = [
  'Settlement moves a merchant balance from the clearing account to their bank account every night.',
  'Payout batches submitted after the cutoff at 22:30 are settled on the next working day instead.',
  'A failed payout is retried twice; after that, the merchant is notified and support takes over.',
  'PromptPay payouts cost 12 THB each and are capped at 2,000,000 THB per merchant per day.',
];

function chunk(id: string, text: string, kind: ContextBlock['source']['kind'] = 'ATTACHMENT') {
  return { source: { kind, id, title: id }, scope: 'FEATURE' as const, text };
}

describe('deduplicating context', () => {
  test('a chunk whose text an earlier block already holds is removed', () => {
    const section = `## Settlement\n${PARAGRAPHS.join('\n\n')}`;
    const copy = `## Settlement (2025 archive)\n${PARAGRAPHS.join('\n\n')}`;
    const before = [shown(chunk('handbook', section))];
    // The same section under another heading, from another document: nothing new.
    expect(unrepeated(chunk('archive', copy), before)).toBeNull();
    // The same chunk again.
    expect(unrepeated(chunk('handbook', section), before)).toBeNull();
    // Text the earlier block doesn't hold is kept as it is.
    const other =
      '## Refunds\nRefunds follow the same route back to the card, within 7 working days.';
    expect(unrepeated(chunk('archive', other), before)).toBe(other);
  });

  test('a short text found inside another by chance is kept', () => {
    const before = [shown(chunk('a', PARAGRAPHS.join('\n\n')))];
    const short = 'Payout batches';
    expect(short.length).toBeLessThan(MIN_REPEAT_CHARS);
    expect(unrepeated(chunk('b', short), before)).toBe(short);
  });

  test("the chunker's overlap with an earlier piece is cut, whichever came first", () => {
    const rules = Array.from(
      { length: 40 },
      (_, i) => `Payout rule ${i + 1}: batches after 22:30 settle on working day ${i + 2}.`,
    );
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      rules.slice(i * 4, i * 4 + 4).join(' '),
    );
    const pieces = chunkMarkdown(`## Payouts\n${paragraphs.join('\n\n')}`);
    const [first, second] = pieces.map((p) => chunk('handbook', p.text));
    if (!first || !second) throw new Error('expected two pieces');
    // The second piece starts with the end of the first (the overlap), under the same heading.
    const overlap = second.text.replace('## Payouts\n', '').split('\n\n')[0] ?? '';
    expect(overlap.length).toBeGreaterThan(MIN_REPEAT_CHARS);
    expect(first.text).toContain(overlap.trim());

    const later = unrepeated(second, [shown(first)]);
    expect(later?.startsWith('## Payouts\n…\n')).toBe(true);
    expect(later).not.toContain(overlap.trim());
    expect(second.text.endsWith(later?.split('\n…\n')[1] ?? '-')).toBe(true);

    // The other way round (the second piece ranked first): the end of the first is cut.
    const earlier = unrepeated(first, [shown(second)]);
    expect(earlier?.endsWith('\n…')).toBe(true);
    expect(earlier).not.toContain(overlap.trim());
    expect(first.text.startsWith(earlier?.slice(0, -2) ?? '-')).toBe(true);
  });

  test("a Spec's first chunk inside its excerpt in the Feature overview is removed", () => {
    const spec = `# Payouts\n\n${PARAGRAPHS.slice(0, 2).join('\n\n')}`;
    const overview = chunk('v1', `Status: DONE\n\n${spec}\n\n${PARAGRAPHS[2]}`, 'SPEC_VERSION');
    expect(unrepeated(chunk('v1', spec, 'SPEC_VERSION'), [shown(overview)])).toBeNull();
  });

  test('the Decision Log is not repeated by retrieved Decisions', () => {
    const logged = `# Decision: Payout cutoff\n\n${PARAGRAPHS[1]}`;
    const blocks = [
      chunk('d1', logged, 'DECISION'),
      chunk('d2', `# Decision: Fees\n\n${PARAGRAPHS[3]}`, 'DECISION'),
    ];
    expect(withoutShown(blocks, [logged]).map((b) => b.source.id)).toEqual(['d2']);
  });
});
