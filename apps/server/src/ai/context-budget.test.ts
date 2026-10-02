import { describe, expect, test } from 'bun:test';
import { CONTEXT_WINDOW_LIMITS, knownContextWindow } from '@vorasaan/shared';
import { z } from 'zod';
import {
  BUDGET_CONFIG,
  CONTEXT_CEILINGS,
  planBudget,
  searchContextBudget,
  toolTokens,
  type Workflow,
} from './context-budget.ts';
import {
  DEFAULT_CONTEXT_WINDOW,
  envContextWindow,
  envModelContextWindow,
  prefilledContextWindow,
} from './context-window.ts';

const WORKFLOWS = Object.keys(CONTEXT_CEILINGS) as Workflow[];
const total = (b: ReturnType<typeof planBudget>) =>
  b.system + b.foundation + b.context + b.history + b.reply;

describe('planBudget (ticket 0060)', () => {
  test('every workflow fits its window, from the smallest allowed to a million tokens', () => {
    for (const window of [CONTEXT_WINDOW_LIMITS.min, 8_000, 16_385, 32_000, 200_000, 1_000_000]) {
      for (const workflow of WORKFLOWS) {
        for (const system of [0, 800, 1_600]) {
          const budget = planBudget(window, workflow, { system });
          expect(total(budget)).toBeLessThanOrEqual(window);
          expect(budget.context).toBeLessThanOrEqual(CONTEXT_CEILINGS[workflow]);
        }
      }
    }
  });

  test('each share keeps its floor on a small model', () => {
    const { floors } = BUDGET_CONFIG;
    const budget = planBudget(8_000, 'conversationFeature', { system: 1_200 });
    expect(budget.reply).toBeGreaterThanOrEqual(floors.reply);
    expect(budget.history).toBeGreaterThanOrEqual(floors.history);
    expect(budget.context).toBeGreaterThanOrEqual(floors.context);
    expect(budget.foundation).toBeGreaterThanOrEqual(floors.foundation);
  });

  test('a larger window gets more context, up to the workflow ceiling', () => {
    const at = (window: number) => planBudget(window, 'conversationFeature', { system: 1_200 });
    expect(at(200_000).context).toBeGreaterThan(at(8_000).context);
    expect(at(32_000).context).toBeGreaterThan(at(8_000).context);
    expect(at(1_000_000).context).toBe(CONTEXT_CEILINGS.conversationFeature);
    expect(at(1_000_000).history).toBe(BUDGET_CONFIG.ceilings.history);
    expect(at(1_000_000).reply).toBe(BUDGET_CONFIG.ceilings.reply);
  });

  test('a one-shot task has no history; its context takes the history share too', () => {
    const oneShot = planBudget(16_000, 'decisionRequest');
    const chat = planBudget(16_000, 'conversationFeature');
    expect(oneShot.history).toBe(0);
    expect(chat.history).toBeGreaterThan(0);
    expect(oneShot.context).toBeGreaterThan(chat.context);
  });

  test('a large fixed part comes out of the foundation first, then the context', () => {
    const light = planBudget(16_000, 'decisionRequest', { system: 1_000 });
    const heavy = planBudget(16_000, 'decisionRequest', { system: 10_000 });
    expect(heavy.foundation).toBe(BUDGET_CONFIG.floors.foundation);
    expect(heavy.context).toBeLessThan(light.context);
    expect(total(heavy)).toBeLessThanOrEqual(16_000);
  });

  test('a search from chat reads a share of the window, within its floor and ceiling', () => {
    const { floor, ceiling } = BUDGET_CONFIG.searchContext;
    expect(searchContextBudget(4_096)).toBe(floor);
    expect(searchContextBudget(32_000)).toBe(1_600);
    expect(searchContextBudget(1_000_000)).toBe(ceiling);
  });

  test('tools cost their name, description and schema', () => {
    const tool = {
      name: 'searchContext',
      description: 'Search the Project for more context.',
      inputSchema: z.object({ query: z.string() }),
    };
    expect(toolTokens([])).toBe(0);
    expect(toolTokens([tool])).toBeGreaterThan(10);
    expect(toolTokens([tool, tool])).toBe(2 * toolTokens([tool]));
  });
});

describe('context windows (ticket 0060)', () => {
  test('known models are prefilled; "provider/" prefixes are understood', () => {
    expect(knownContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(knownContextWindow('anthropic/claude-haiku-4-5')).toBe(200_000);
    expect(knownContextWindow('gpt-4o-mini')).toBe(128_000);
    expect(knownContextWindow('openai/gpt-5.6-sol')).toBe(400_000);
    expect(knownContextWindow('qwen-3-coder')).toBeNull();
  });

  test('an unknown model gets VORASAAN_CONTEXT_WINDOW, else the default', () => {
    expect(prefilledContextWindow('qwen-3-coder', {})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(prefilledContextWindow('qwen-3-coder', { VORASAAN_CONTEXT_WINDOW: '8192' })).toBe(8_192);
    // A known model keeps its own window.
    expect(prefilledContextWindow('claude-haiku-4-5', { VORASAAN_CONTEXT_WINDOW: '8192' })).toBe(
      200_000,
    );
  });

  test('an env model: VORASAAN_CONTEXT_WINDOW wins, then the known window, then the default', () => {
    expect(envModelContextWindow('anthropic/claude-haiku-4-5', {})).toBe(200_000);
    expect(
      envModelContextWindow('anthropic/claude-haiku-4-5', { VORASAAN_CONTEXT_WINDOW: '16_000' }),
    ).toBe(16_000);
    expect(envModelContextWindow('custom/local', {})).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test('a VORASAAN_CONTEXT_WINDOW that is not a whole number within the limits is ignored', () => {
    for (const bad of ['', 'big', '1.5', '100', '99999999999']) {
      expect(envContextWindow({ VORASAAN_CONTEXT_WINDOW: bad })).toBeUndefined();
    }
  });
});
