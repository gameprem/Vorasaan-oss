import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { type FakeOpenRouter, startFakeOpenRouter } from '../test/fake-openrouter.ts';
import type { ChatChunk, ContextBlock, GuidelineForAi, RequestForAi } from './ai.port.ts';
import { MastraAiPort, pingModel } from './mastra-ai.port.ts';
import { toMastraModel } from './model-config.ts';
import {
  listOpenRouterModels,
  OPENROUTER_DEFAULT_URL,
  openRouterBaseUrl,
  openRouterContextWindow,
  openRouterHeaders,
} from './openrouter.ts';
import { chatPrompt, generateChoicesPrompt } from './prompts.ts';

// Ticket 0064: OpenRouter through MastraAiPort, against a local stand-in for its
// API. Anthropic models (`anthropic/…`) get the stable prefix marked with
// cache_control in content parts; other models get the same text unmarked. Every
// call carries HTTP-Referer and X-Title, and its cache usage is logged.

// Keys unique to this file: Mastra keeps model instances per key, URL included.
const KEY = 'sk-or-v1-openrouter-test-key-0064';

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

const guidelines: GuidelineForAi[] = [
  { title: 'Serves a KPI', description: 'Names the KPI it moves.', kind: 'KPI', required: true },
];
const foundation = {
  brief: { version: 3, markdown: `# Brief\n${'Mobile banking for small shops. '.repeat(40)}` },
  guidelines,
};
const SPEC = `# Card freeze\n${'A customer can freeze a card from the app. '.repeat(30)}`;
const request: RequestForAi = {
  kind: 'BLOCKER',
  title: 'No webhook from the card processor',
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};
const context: ContextBlock[] = [
  {
    source: { kind: 'DECISION', id: 'd1', title: 'Poll every 5s' },
    scope: 'FEATURE',
    text: 'Decided to poll.',
  },
];
const choicesInput = { specMarkdown: SPEC, request, context, foundation };

const chatInput = {
  scope: {
    kind: 'FEATURE' as const,
    project: { name: 'Mobile Banking' },
    feature: { title: 'Card freeze', description: '' },
  },
  context: [
    {
      source: { kind: 'SPEC_VERSION' as const, id: 's1', title: 'Spec: Card freeze', version: 2 },
      scope: 'FEATURE' as const,
      text: SPEC,
    },
    ...context,
  ],
  foundation,
  summary: '## Goal\n- Freeze cards',
  recentMessages: [
    { role: 'USER' as const, content: 'What about timeouts?' },
    { role: 'ASSISTANT' as const, content: 'We poll every 5s.' },
    { role: 'USER' as const, content: 'And retries?' },
  ],
  tools: [],
};

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const MARK = { type: 'ephemeral' };

type Part = { type: string; text: string; cache_control?: unknown };
type Message = { role: string; content: string | Part[] };

const textOf = (m: Message | undefined) =>
  typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p) => p.text).join('');

describe('OpenRouter calls', () => {
  let fake: FakeOpenRouter;
  let previousUrl: string | undefined;
  let previousWebUrl: string | undefined;
  const port = (model: string, apiKey = KEY) =>
    new MastraAiPort(async () =>
      toMastraModel({ provider: 'OPENROUTER', model, apiKey, baseUrl: null }),
    );

  beforeAll(() => {
    fake = startFakeOpenRouter(KEY);
    previousUrl = process.env.OPENROUTER_BASE_URL;
    previousWebUrl = process.env.VORASAAN_WEB_URL;
    process.env.OPENROUTER_BASE_URL = fake.url;
    process.env.VORASAAN_WEB_URL = 'https://vorasaan.example.com';
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previousUrl;
    if (previousWebUrl === undefined) delete process.env.VORASAAN_WEB_URL;
    else process.env.VORASAAN_WEB_URL = previousWebUrl;
    fake.stop();
  });

  test('an anthropic/… model: the stable parts carry cache_control, the request does not; usage is logged', async () => {
    fake.requests.length = 0;
    fake.structured = CHOICES;
    const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      expect(await port('anthropic/example-model').generateChoices(choicesInput)).toEqual(
        CHOICES as never,
      );
      // OpenRouter's cache reads and writes (cached_tokens, cache_write_tokens), logged.
      expect(log).toHaveBeenCalledWith(
        'generate-choices: input 1840 (cache read 1500, cache write 300), output 12',
      );
    } finally {
      log.mockRestore();
    }
    const [call] = fake.requests;
    expect(call?.path).toBe('/api/v1/chat/completions');
    expect(call?.body?.model).toBe('anthropic/example-model');
    const messages = call?.body?.messages as Message[];
    const user = messages.filter((m) => m.role === 'user');
    expect(user).toHaveLength(1);
    const parts = user[0]?.content as Part[];
    const prompt = await generateChoicesPrompt(SPEC, request, context, foundation);
    expect(parts.map((p) => p.text)).toEqual(prompt.parts);
    expect(parts.map((p) => p.cache_control)).toEqual([MARK, MARK, undefined]);
    expect(parts[2]?.text).toContain('No webhook from the card processor');
    // The short generic system prompt is not marked on its own.
    for (const m of messages.filter((m) => m.role === 'system')) {
      expect(JSON.stringify(m)).not.toContain('cache_control');
    }
  });

  test('an anthropic/… chat: system blocks marked up to the Spec; the history is not', async () => {
    fake.requests.length = 0;
    const chunks = await collect(port('anthropic/example-model').chat(chatInput));
    expect(chunks).toEqual([{ type: 'text', delta: 'Retry three times.' }]);
    const messages = fake.requests[0]?.body?.messages as Message[];
    const prompt = await chatPrompt(chatInput);
    const system = messages.filter((m) => m.role === 'system');
    expect(system.map(textOf)).toEqual(prompt.parts);
    expect(system.map((m) => (m.content as Part[])[0]?.cache_control)).toEqual([
      MARK,
      MARK,
      undefined,
    ]);
    const history = messages.filter((m) => m.role !== 'system');
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(history)).not.toContain('cache_control');
    expect(JSON.stringify(messages).match(/cache_control/g)?.length ?? 0).toBeLessThanOrEqual(4);
  });

  test('any other model gets the same text with no marks', async () => {
    fake.requests.length = 0;
    fake.structured = CHOICES;
    await port('example/model').generateChoices(choicesInput);
    await collect(port('example/model').chat(chatInput));
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) expect(JSON.stringify(r.body)).not.toContain('cache_control');
    const [task, chat] = fake.requests.map((r) => r.body?.messages as Message[]);
    const choices = await generateChoicesPrompt(SPEC, request, context, foundation);
    expect(task?.filter((m) => m.role === 'user').map(textOf)).toEqual([choices.text]);
    const system = chat?.filter((m) => m.role === 'system') ?? [];
    expect(system.map(textOf)).toEqual([(await chatPrompt(chatInput)).text]);
  });

  test('every call sends HTTP-Referer and X-Title: Vorasaan, and the key only as its bearer', async () => {
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.headers['http-referer']).toBe('https://vorasaan.example.com');
      expect(r.headers['x-title']).toBe('Vorasaan');
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(r.body)).not.toContain(KEY);
    }
  });

  test('token counting is the estimate: OpenRouter has no counting call', async () => {
    fake.requests.length = 0;
    const counted = await new MastraAiPort().countTokens(
      { system: 'You help.', messages: [{ role: 'USER', content: 'Hello there' }] },
      {
        model: {
          source: 'APPROVED_MODEL',
          approvedModelId: 'm1',
          integrationId: 'i1',
          provider: {
            provider: 'OPENROUTER',
            model: 'anthropic/example-model',
            apiKey: KEY,
            baseUrl: null,
          },
          name: 'anthropic/example-model',
          contextWindow: 200_000,
        },
      },
    );
    expect(counted).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('test connection succeeds, and reports the error otherwise', async () => {
    fake.structured = { reply: 'ok' };
    await pingModel(
      toMastraModel({ provider: 'OPENROUTER', model: 'example/model', apiKey: KEY, baseUrl: null }),
    );
    const wrongKey = 'sk-or-v1-wrong-key-for-the-fake-0064';
    // Mastra logs the provider's error with its body, which echoes the key: masked.
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' '));
      }),
    );
    try {
      await expect(
        pingModel(
          toMastraModel({
            provider: 'OPENROUTER',
            model: 'example/model',
            apiKey: wrongKey,
            baseUrl: null,
          }),
        ),
      ).rejects.toThrow('No auth credentials found');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).toContain('No auth credentials found for …');
    expect(logged.join('\n')).not.toContain(wrongKey);
  });
});

describe("OpenRouter's model list", () => {
  let fake: FakeOpenRouter;
  const env = () => ({ OPENROUTER_BASE_URL: fake.url });

  beforeAll(() => {
    fake = startFakeOpenRouter(KEY);
  });

  afterAll(() => fake.stop());

  test('lists the models by name with their context windows, without sending a key', async () => {
    fake.requests.length = 0;
    fake.modelsStatus = null;
    fake.models = [
      { id: 'example/zeta', name: 'Example: Zeta', context_length: 131_072 },
      { id: 'anthropic/example-model', name: 'Anthropic: Example', context_length: 200_000 },
      { id: 'example/tiny', name: 'Example: Tiny', context_length: 1_024 },
      { id: 'example/unnamed', context_length: null },
    ];
    const list = await listOpenRouterModels(env());
    expect(list).toEqual({
      models: [
        { id: 'anthropic/example-model', name: 'Anthropic: Example', contextWindow: 200_000 },
        { id: 'example/tiny', name: 'Example: Tiny', contextWindow: null },
        { id: 'example/zeta', name: 'Example: Zeta', contextWindow: 131_072 },
        { id: 'example/unnamed', name: 'example/unnamed', contextWindow: null },
      ],
      error: null,
    });
    expect(fake.requests[0]?.path).toBe('/api/v1/models');
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(await openRouterContextWindow('anthropic/example-model', env())).toBe(200_000);
    expect(await openRouterContextWindow('example/missing', env())).toBeNull();
  });

  test('a list that cannot be loaded is an error, never a throw', async () => {
    fake.modelsStatus = 503;
    expect(await listOpenRouterModels(env())).toEqual({
      models: [],
      error: 'OpenRouter answered 503 for its model list',
    });
    fake.modelsStatus = null;
    const unreachable = await listOpenRouterModels({
      OPENROUTER_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    expect(unreachable.models).toEqual([]);
    expect(unreachable.error).toStartWith("Could not load OpenRouter's model list");
  });
});

describe('OpenRouter settings from env', () => {
  test('the base URL is fixed unless the operator overrides it with an http(s) URL', () => {
    expect(openRouterBaseUrl({})).toBe(OPENROUTER_DEFAULT_URL);
    expect(OPENROUTER_DEFAULT_URL).toBe('https://openrouter.ai/api/v1');
    expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: 'http://localhost:1234/api/v1/' })).toBe(
      'http://localhost:1234/api/v1',
    );
    expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: 'file:///etc/passwd' })).toBe(
      OPENROUTER_DEFAULT_URL,
    );
    expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: 'not a url' })).toBe(OPENROUTER_DEFAULT_URL);
  });

  test('HTTP-Referer is the public origin, never a header-breaking value', () => {
    expect(openRouterHeaders({})).toEqual({
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Vorasaan',
    });
    expect(openRouterHeaders({ VORASAAN_WEB_URL: 'https://team.example.com/path?q=1' })).toEqual({
      'HTTP-Referer': 'https://team.example.com',
      'X-Title': 'Vorasaan',
    });
    const injected = openRouterHeaders({
      VORASAAN_WEB_URL: 'https://team.example.com\r\nX-Evil: 1',
    })['HTTP-Referer'];
    expect(injected).not.toMatch(/[\r\n]/);
    expect(openRouterHeaders({ VORASAAN_WEB_URL: 'javascript:alert(1)' })['HTTP-Referer']).toBe(
      'http://localhost:3000',
    );
  });
});
