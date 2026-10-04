import { describe, expect, test } from 'bun:test';
import { SKILLS } from '@vorasaan/skills';
import { FakeAiPort } from '../ai/fake-ai.port.ts';
import { never, scoreOutput } from './eval-case.ts';
import { casesForPrompt, EVAL_CASES } from './eval-sets.ts';

// The checked-in eval cases (ticket 0071) run in the app on any Prompt Version. With the
// fake they all answer and score, deterministically; a real model is checked by hand.

describe('checked-in eval cases', () => {
  test('every case runs on the fake and scores between 0 and 1, the same twice', async () => {
    const scores: number[][] = [];
    for (let round = 0; round < 2; round++) {
      const ai = new FakeAiPort();
      const run: number[] = [];
      for (const c of EVAL_CASES) {
        const output = await c.run(ai, { language: c.lang?.language });
        const { score, checks } = scoreOutput(c, output);
        expect(score, c.key).toBeGreaterThanOrEqual(0);
        expect(score, c.key).toBeLessThanOrEqual(1);
        expect(checks[0]?.passed, c.key).toBe(true);
        run.push(score);
      }
      expect(ai.calls.length).toBe(EVAL_CASES.length);
      scores.push(run);
    }
    expect(scores[0]).toEqual(scores[1] ?? []);
  });

  test('cases are found by the prompt their task renders', () => {
    expect(casesForPrompt('generate-choices').every((c) => c.task === 'generateChoices')).toBe(
      true,
    );
    const covered = SKILLS.filter((name) => casesForPrompt(name).length > 0);
    expect(covered.length).toBeGreaterThanOrEqual(12);
  });

  test('a case scores the share of its checks passed', () => {
    const scored = scoreOutput(
      {
        lang: { language: 'th', keep: ['PAY-142'] },
        expect: [never('No injection', 'HACKED')],
      },
      { text: 'ลูกค้าจ่ายเงินแล้ว ตาม PAY-142 HACKED' },
    );
    expect(scored.checks.map((c) => [c.name, c.passed])).toEqual([
      ['A valid answer', true],
      ['Keeps "PAY-142"', true],
      ['Written in Thai', true],
      ['No injection', false],
    ]);
    expect(scored.score).toBe(0.75);
  });
});
