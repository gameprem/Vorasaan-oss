import { describe, expect, test } from 'bun:test';
import { AI_TASKS, type AiTask } from '../ai/ai.config.ts';
import type { CallUsage, ChatChunk } from '../ai/ai.port.ts';
import { FAKE_USAGE, FakeAiPort } from '../ai/fake-ai.port.ts';
import { generateChoicesPrompt, TASK_PROMPTS } from '../ai/prompts.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { cacheableTokens, measuringAiPort, type PromptMeasure } from './prompt-tokens.ts';
import { EVAL_CASE_GUARD } from './token-guard.ts';
import { measureEvalCases, summarizeCases } from './token-report.ts';

// Ticket 0076: tokens are measured on the exact prompt a provider would get, and no task's
// checked-in eval cases may cost more, or score less, than after its optimizations.

const request = {
  kind: 'BLOCKER' as const,
  raiserRole: 'BACKEND' as const,
  title: 'Provider has no webhook',
  description: 'Only polling is available.',
};

describe('measuring prompts', () => {
  test("a call's usage is its rendered prompt by the estimate, not the fake's", async () => {
    const measures: PromptMeasure[] = [];
    const usage: CallUsage[] = [];
    const fake = new FakeAiPort();
    const ai = measuringAiPort(fake, { onMeasure: (m) => measures.push(m) });
    const input = { specMarkdown: '# Spec', request, context: [] };
    const output = await ai.generateChoices(input, {
      language: 'th',
      onUsage: (u) => usage.push(u),
    });
    // The answer is the fake's, the call recorded once.
    expect(output).toEqual(await new FakeAiPort().generateChoices(input));
    expect(fake.calls).toHaveLength(1);

    const prompt = await generateChoicesPrompt('# Spec', request, [], undefined, {
      language: 'th',
      strategy: 'direct',
    });
    expect(prompt.text).toContain('Thai');
    expect(measures).toEqual([
      {
        task: 'generateChoices',
        tokens: estimateTokens(prompt.text),
        cacheable: cacheableTokens(prompt),
        uncached: estimateTokens(prompt.text) - cacheableTokens(prompt),
        output: estimateTokens(JSON.stringify(output)),
      },
    ]);
    expect(usage).toEqual([
      {
        inputTokens: estimateTokens(prompt.text),
        outputTokens: estimateTokens(JSON.stringify(output)),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    expect(usage[0]?.inputTokens).not.toBe(FAKE_USAGE.inputTokens);
  });

  test('a chat counts its instructions, messages and tools, and ends with that usage', async () => {
    const measures: PromptMeasure[] = [];
    const ai = measuringAiPort(new FakeAiPort(), { onMeasure: (m) => measures.push(m) });
    const chunks: ChatChunk[] = [];
    for await (const chunk of ai.chat({
      scope: { kind: 'PROJECT', project: { name: 'P' } },
      context: [],
      foundation: { brief: null, guidelines: [] },
      summary: '',
      recentMessages: [{ role: 'USER', content: 'What is open?' }],
      tools: [],
    })) {
      chunks.push(chunk);
    }
    const usage = chunks.filter((c) => c.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({
      type: 'usage',
      usage: { inputTokens: measures[0]?.tokens ?? -1, cacheReadTokens: 0 },
    });
    expect(measures[0]?.task).toBe('chat');
    expect(measures[0]?.cacheable).toBeGreaterThan(0);
  });

  test('every task but chat renders its prompt from its input', () => {
    expect([...Object.keys(TASK_PROMPTS), 'chat'].sort()).toEqual(Object.keys(AI_TASKS).sort());
  });
});

describe('the eval guard on the checked-in cases', () => {
  test('no task costs more or scores less than after ticket 0076, Thai cases included', async () => {
    const summary = summarizeCases(await measureEvalCases());
    expect(summary.map((s): string => s.task).sort()).toEqual(Object.keys(EVAL_CASE_GUARD).sort());
    for (const s of summary) {
      const guard = EVAL_CASE_GUARD[s.task as Exclude<AiTask, 'draftSpecProposal'>];
      expect(s.tokens, `${s.task} tokens`).toBeLessThanOrEqual(guard.tokens);
      expect(s.score, `${s.task} score`).toBeGreaterThanOrEqual(guard.score);
      if (guard.thai !== undefined) {
        expect(s.thaiScore ?? 0, `${s.task} Thai score`).toBeGreaterThanOrEqual(guard.thai);
      }
    }
  });
});
