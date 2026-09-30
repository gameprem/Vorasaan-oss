import { describe, expect, test } from 'bun:test';
import { loadAiConfig } from './ai.config.ts';
import { AiOutputError, GeneratedChoices } from './ai.port.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';

const valid = {
  suggestedRole: 'PO',
  choices: ['A', 'B'].map((label) => ({
    label,
    title: `Option ${label}`,
    description: 'd',
    impactScope: 's',
    impactTime: 't',
    impactRisk: 'r',
  })),
};

function stub(responses: unknown[]): StructuredGenerate & { count: number } {
  const fn = Object.assign(
    async () => {
      const next = responses[fn.count++];
      if (next instanceof Error) throw next;
      return next;
    },
    { count: 0 },
  );
  return fn;
}

describe('generateStructured', () => {
  test('returns valid output on the first try', async () => {
    const generate = stub([valid]);
    expect(await generateStructured(generate, 't', 'p', GeneratedChoices)).toEqual(valid as never);
    expect(generate.count).toBe(1);
  });

  test('retries once on invalid output', async () => {
    const generate = stub([{ choices: [] }, valid]);
    expect((await generateStructured(generate, 't', 'p', GeneratedChoices)).choices).toHaveLength(
      2,
    );
    expect(generate.count).toBe(2);
  });

  test('retries once on a thrown error', async () => {
    const generate = stub([new Error('rate limited'), valid]);
    await generateStructured(generate, 't', 'p', GeneratedChoices);
    expect(generate.count).toBe(2);
  });

  test('gives up after two invalid results', async () => {
    const generate = stub([{ nope: true }, { still: 'no' }, valid]);
    await expect(
      generateStructured(generate, 'generate-choices', 'p', GeneratedChoices),
    ).rejects.toThrow(AiOutputError);
  });
});

describe('loadAiConfig', () => {
  test('defaults every task to Claude Opus 5.5', () => {
    expect(loadAiConfig({})).toEqual({
      generateChoicesModel: 'anthropic/claude-opus-5-5',
      draftSpecProposalModel: 'anthropic/claude-opus-5-5',
    });
  });

  test('model is configurable globally and per task', () => {
    expect(
      loadAiConfig({
        VORASAAN_MODEL: 'openai/some-model',
        VORASAAN_MODEL_GENERATE_CHOICES: 'anthropic/claude-haiku-4-5',
      }),
    ).toEqual({
      generateChoicesModel: 'anthropic/claude-haiku-4-5',
      draftSpecProposalModel: 'openai/some-model',
    });
  });
});

describe('FakeAiPort', () => {
  test('produces output that satisfies the real schemas', async () => {
    const ai = new FakeAiPort();
    const result = await ai.generateChoices({
      specMarkdown: '# Spec',
      request: { kind: 'BLOCKER', title: 'Slow API', description: 'd', raiserRole: 'BACKEND' },
    });
    expect(GeneratedChoices.safeParse(result).success).toBe(true);
  });
});
