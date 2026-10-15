import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { ReasoningLevel } from '@vorasaan/shared';
import { type FakeAnthropic, startFakeAnthropic } from '../test/fake-anthropic.ts';
import { type FakeGemini, gemmaRefusesThinking, startFakeGemini } from '../test/fake-gemini.ts';
import { type FakeOpenAi, startFakeOpenAi } from '../test/fake-openai.ts';
import { type FakeOpenRouter, startFakeOpenRouter } from '../test/fake-openrouter.ts';
import type { AiCallOptions, CallUsage, ChatChunk, RequestForAi } from './ai.port.ts';
import { MastraAiPort, pingModel } from './mastra-ai.port.ts';
import { type MastraModel, toMastraModel } from './model-config.ts';

// Ticket 0081: MastraAiPort against local stand-ins for each provider's API. Each provider
// kind receives its own reasoning parameter for each level, a model that refuses it gets
// none, a 400 caused by it is retried once without it, and the reasoning tokens each
// provider reports reach the log line and the usage a Receipt gets.

type Json = Record<string, unknown>;

// Keys unique to this file: Mastra keeps model instances per key, URL included.
const KEYS = {
  anthropic: 'sk-ant-reasoning-test-key-0081',
  openai: 'sk-openai-reasoning-test-key-0081',
  openrouter: 'sk-or-reasoning-test-key-0081',
  gemini: 'AIza-reasoning-test-key-0081',
};

const CHOICES = {
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

const request: RequestForAi = {
  kind: 'BLOCKER',
  title: 'No webhook from the card processor',
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};
const choicesInput = { specMarkdown: '# Card freeze', request, context: [] };
const chatInput = {
  scope: {
    kind: 'FEATURE' as const,
    project: { name: 'Mobile Banking' },
    feature: { title: 'Card freeze', description: '' },
  },
  context: [],
  foundation: { brief: null, guidelines: [] },
  summary: '',
  recentMessages: [{ role: 'USER' as const, content: 'And retries?' }],
  tools: [],
};

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const at = (level: ReasoningLevel): AiCallOptions => ({ reasoning: { level, source: 'SETTINGS' } });

let anthropic: FakeAnthropic;
let openai: FakeOpenAi;
let openrouter: FakeOpenRouter;
let gemini: FakeGemini;
const previous: Record<string, string | undefined> = {};
const BASE_URLS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'GOOGLE_BASE_URL',
] as const;

beforeAll(() => {
  anthropic = startFakeAnthropic(KEYS.anthropic);
  openai = startFakeOpenAi(KEYS.openai);
  openrouter = startFakeOpenRouter(KEYS.openrouter);
  gemini = startFakeGemini(KEYS.gemini);
  for (const name of BASE_URLS) previous[name] = process.env[name];
  process.env.ANTHROPIC_BASE_URL = anthropic.url;
  process.env.OPENAI_BASE_URL = openai.url;
  process.env.OPENROUTER_BASE_URL = openrouter.url;
  process.env.GOOGLE_BASE_URL = gemini.url;
});

afterAll(() => {
  for (const name of BASE_URLS) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  anthropic.stop();
  openai.stop();
  openrouter.stop();
  gemini.stop();
});

type Kind = 'ANTHROPIC' | 'OPENAI' | 'OPENROUTER' | 'GEMINI';

const model = (provider: Kind, id: string): MastraModel =>
  toMastraModel({
    provider,
    model: id,
    apiKey: KEYS[provider === 'GEMINI' ? 'gemini' : (provider.toLowerCase() as 'openai')],
    baseUrl: null,
  });
const port = (provider: Kind, id: string) => new MastraAiPort(async () => model(provider, id));

/** Each stand-in: its last request bodies, and where its reasoning parameter sits in one. */
const providers = {
  ANTHROPIC: {
    bodies: () => anthropic.requests.map((r) => r.body ?? {}),
    clear: () => {
      anthropic.requests.length = 0;
    },
    param: (b: Json) => (b.output_config as Json | undefined)?.effort,
    model: 'claude-opus-5-5',
    refuses: 'claude-sonnet-4-5',
  },
  OPENAI: {
    bodies: () => openai.requests.map((r) => r.body ?? {}),
    clear: () => {
      openai.requests.length = 0;
    },
    param: (b: Json) => (b.reasoning as Json | undefined)?.effort,
    model: 'gpt-5.6-sol',
    refuses: 'gpt-4o',
  },
  OPENROUTER: {
    bodies: () => openrouter.requests.map((r) => r.body ?? {}),
    clear: () => {
      openrouter.requests.length = 0;
    },
    param: (b: Json) => (b.reasoning as Json | undefined)?.effort,
    model: 'anthropic/claude-opus-5-5',
    refuses: 'google/gemma-3-27b-it',
  },
  GEMINI: {
    bodies: () => gemini.requests.map((r) => r.body ?? {}),
    clear: () => {
      gemini.requests.length = 0;
    },
    param: (b: Json) =>
      ((b.generationConfig as Json | undefined)?.thinkingConfig as Json | undefined)?.thinkingLevel,
    model: 'gemini-3-example-flash',
    refuses: 'gemma-example-27b-it',
  },
} as const;

/** Without the usage lines, and without Mastra's own log of a provider's error. */
function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const error = spyOn(console, 'error').mockImplementation(() => {});
  return run().finally(() => {
    log.mockRestore();
    error.mockRestore();
  });
}

describe('each provider kind receives its own parameter for each level', () => {
  beforeAll(() => {
    anthropic.structured = CHOICES;
    openai.structured = CHOICES;
    openrouter.structured = CHOICES;
    gemini.structured = CHOICES;
  });

  for (const kind of Object.keys(providers) as Kind[]) {
    test(`${kind}: a task and a chat at LOW, MEDIUM and HIGH`, async () => {
      const p = providers[kind];
      p.clear();
      await quietly(async () => {
        for (const level of ['LOW', 'MEDIUM', 'HIGH'] as const) {
          expect(await port(kind, p.model).generateChoices(choicesInput, at(level))).toEqual(
            CHOICES as never,
          );
          await collect(port(kind, p.model).chat(chatInput, at(level)));
        }
      });
      expect(p.bodies().map(p.param)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high']);
    });

    test(`${kind}: a model that refuses the parameter receives none`, async () => {
      const p = providers[kind];
      p.clear();
      await quietly(async () => {
        await port(kind, p.refuses).generateChoices(choicesInput, at('HIGH'));
        await collect(port(kind, p.refuses).chat(chatInput, at('HIGH')));
      });
      expect(p.bodies()).toHaveLength(2);
      for (const body of p.bodies()) {
        expect(p.param(body)).toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(/thinking|"effort"|reasoning_effort/);
      }
    });
  }

  test('Anthropic never gets thinking disabled or a budget', () => {
    for (const body of providers.ANTHROPIC.bodies()) expect(body.thinking).toBeUndefined();
  });

  test('Gemini 2.5 gets a budget by level, as in ticket 0080', async () => {
    gemini.requests.length = 0;
    gemini.structured = { reply: 'ok' };
    await quietly(async () => {
      // The connection test runs at LOW.
      await pingModel(model('GEMINI', 'gemini-2.5-flash'));
      await pingModel(model('GEMINI', 'gemini-2.5-pro'));
    });
    gemini.structured = CHOICES;
    await quietly(() =>
      port('GEMINI', 'gemini-2.5-flash').generateChoices(choicesInput, at('MEDIUM')),
    );
    expect(
      gemini.requests.map((r) => (r.body?.generationConfig as Json | undefined)?.thinkingConfig),
    ).toEqual([{ thinkingBudget: 0 }, { thinkingBudget: 128 }, { thinkingBudget: 2048 }]);
  });

  test('an OpenAI-compatible endpoint gets nothing', async () => {
    openrouter.requests.length = 0;
    const custom: MastraModel = {
      providerId: 'custom',
      modelId: 'local-model',
      url: openrouter.url,
      apiKey: KEYS.openrouter,
    };
    await quietly(() => collect(new MastraAiPort(async () => custom).chat(chatInput, at('HIGH'))));
    expect(openrouter.requests).toHaveLength(1);
    expect(JSON.stringify(openrouter.requests[0]?.body)).not.toMatch(/reasoning|effort/);
  });
});

describe('without a chosen level (the eval scripts), the task’s default or the env', () => {
  test('a structured task at LOW, chat at MEDIUM, a message’s HIGH, and the env override', async () => {
    const p = providers.ANTHROPIC;
    p.clear();
    const previousEnv = process.env.VORASAAN_REASONING_GENERATE_CHOICES;
    await quietly(async () => {
      await port('ANTHROPIC', p.model).generateChoices(choicesInput);
      await collect(port('ANTHROPIC', p.model).chat(chatInput));
      await collect(port('ANTHROPIC', p.model).chat(chatInput, { reasoningLevel: 'HIGH' }));
      process.env.VORASAAN_REASONING_GENERATE_CHOICES = 'medium';
      try {
        await port('ANTHROPIC', p.model).generateChoices(choicesInput);
      } finally {
        if (previousEnv === undefined) delete process.env.VORASAAN_REASONING_GENERATE_CHOICES;
        else process.env.VORASAAN_REASONING_GENERATE_CHOICES = previousEnv;
      }
    });
    expect(p.bodies().map(p.param)).toEqual(['low', 'medium', 'high', 'medium']);
  });

  test('VORASAAN_GEMINI_THINKING (ticket 0080) still works for Gemini: default sends nothing', async () => {
    const before = process.env.VORASAAN_GEMINI_THINKING;
    gemini.requests.length = 0;
    try {
      process.env.VORASAAN_GEMINI_THINKING = 'default';
      await quietly(() => port('GEMINI', 'gemini-3-example-flash').generateChoices(choicesInput));
      process.env.VORASAAN_GEMINI_THINKING = 'high';
      await quietly(() => port('GEMINI', 'gemini-3-example-flash').generateChoices(choicesInput));
    } finally {
      if (before === undefined) delete process.env.VORASAAN_GEMINI_THINKING;
      else process.env.VORASAAN_GEMINI_THINKING = before;
    }
    expect(JSON.stringify(gemini.requests[0]?.body)).not.toContain('thinking');
    expect(providers.GEMINI.param(gemini.requests[1]?.body ?? {})).toBe('high');
  });
});

describe('a 400 caused by the parameter is retried once without it', () => {
  for (const kind of Object.keys(providers) as Kind[]) {
    test(`${kind}: a task and a chat`, async () => {
      const p = providers[kind];
      const refuse = (body: Json) =>
        p.param(body)
          ? `The ${kind === 'ANTHROPIC' ? 'effort' : 'reasoning'} setting is not supported for this model.`
          : null;
      if (kind === 'ANTHROPIC') anthropic.refuse = refuse;
      if (kind === 'OPENAI') openai.refuse = refuse;
      if (kind === 'OPENROUTER') openrouter.refuse = refuse;
      if (kind === 'GEMINI') gemini.refuse = (_m, body) => refuse(body);
      p.clear();
      const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      try {
        await quietly(async () => {
          expect(await port(kind, p.model).generateChoices(choicesInput, at('MEDIUM'))).toEqual(
            CHOICES as never,
          );
          const chunks = await collect(port(kind, p.model).chat(chatInput, at('MEDIUM')));
          expect(chunks[0]).toEqual({ type: 'text', delta: 'Retry three times.' });
        });
        // Logged, once per call.
        const retries = warn.mock.calls.filter((c) =>
          String(c[0]).includes('refused its reasoning parameter'),
        );
        expect(retries).toHaveLength(2);
      } finally {
        warn.mockRestore();
        anthropic.refuse = () => null;
        openai.refuse = () => null;
        openrouter.refuse = () => null;
        gemini.refuse = gemmaRefusesThinking;
      }
      expect(p.bodies().map((b) => p.param(b) ?? null)).toEqual(['medium', null, 'medium', null]);
    });
  }

  test('only once, and never for any other 400', async () => {
    // The connection test is one provider call (a structured task's failed call is tried
    // again by generateStructured, whatever failed).
    const claude = model('ANTHROPIC', 'claude-opus-5-5');
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      anthropic.refuse = () => 'This model does not support the effort parameter.';
      anthropic.requests.length = 0;
      await expect(quietly(() => pingModel(claude))).rejects.toThrow();
      expect(anthropic.requests).toHaveLength(2);
      expect(providers.ANTHROPIC.param(anthropic.requests[1]?.body ?? {})).toBeUndefined();

      anthropic.refuse = () => 'prompt is too long: 300000 tokens > 200000 maximum';
      anthropic.requests.length = 0;
      await expect(quietly(() => pingModel(claude))).rejects.toThrow();
      expect(anthropic.requests).toHaveLength(1);
    } finally {
      warn.mockRestore();
      anthropic.refuse = () => null;
    }
  });
});

describe('reasoning tokens from every provider reach the log and the usage', () => {
  const cases: { kind: Kind; usage: (set: boolean) => void; reasoning: number }[] = [
    { kind: 'ANTHROPIC', usage: () => {}, reasoning: 70 },
    { kind: 'OPENAI', usage: () => {}, reasoning: 96 },
    {
      kind: 'OPENROUTER',
      usage: () => {
        openrouter.usage = {
          ...openrouter.usage,
          completion_tokens: 64,
          completion_tokens_details: { reasoning_tokens: 48 },
        };
      },
      reasoning: 48,
    },
    { kind: 'GEMINI', usage: () => {}, reasoning: 30 },
  ];
  for (const c of cases) {
    test(c.kind, async () => {
      c.usage(true);
      const usages: CallUsage[] = [];
      const lines: string[] = [];
      const log = spyOn(Logger.prototype, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        await port(c.kind, providers[c.kind].model).generateChoices(choicesInput, {
          ...at('LOW'),
          onUsage: (u) => usages.push(u),
        });
        await collect(
          port(c.kind, providers[c.kind].model).chat(chatInput, {
            ...at('HIGH'),
            onUsage: (u) => usages.push(u),
          }),
        );
      } finally {
        log.mockRestore();
      }
      expect(usages.map((u) => u.reasoningTokens)).toEqual([c.reasoning, c.reasoning]);
      expect(lines.filter((l) => l.includes(`(reasoning ${c.reasoning})`))).toHaveLength(2);
    });
  }
});
