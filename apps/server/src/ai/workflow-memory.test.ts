import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { emptyMemory, rememberRound, renderMemory } from './workflow-memory.ts';

describe('workflow memory', () => {
  test('keeps short summaries of the most recent rounds only', () => {
    const limits = { maxRounds: 2, maxSummaryTokens: 15 };
    let memory = emptyMemory();
    expect(renderMemory(memory)).toBe('(No earlier rounds.)');
    memory = rememberRound(memory, 'Business goals: faster checkout.', limits);
    memory = rememberRound(memory, 'UX: one-tap retry.', limits);
    memory = rememberRound(memory, `Technical: ${'polling '.repeat(50)}`, limits);

    expect(memory.rounds.map((r) => r.round)).toEqual([2, 3]);
    expect(memory.rounds.every((r) => r.summary.length <= 60)).toBe(true);
    // Thai is cut by its own estimate, not at four characters per token.
    const thai = rememberRound(emptyMemory(), 'สรุป'.repeat(20), limits);
    expect(thai.rounds[0]?.summary).toStartWith('สรุป');
    expect(estimateTokens(thai.rounds[0]?.summary ?? '')).toBeLessThanOrEqual(15);
    expect(renderMemory(memory)).toStartWith('Round 2: UX: one-tap retry.\nRound 3: Technical:');
  });

  test('never changes the memory it is given', () => {
    const before = emptyMemory();
    rememberRound(before, 'x');
    expect(before.rounds).toEqual([]);
  });
});
