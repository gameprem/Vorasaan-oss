import { describe, expect, test } from 'bun:test';
import { MastraAiPort } from './mastra-ai.port.ts';
import { mastraModelOf, toMastraModel } from './model-config.ts';

describe('toMastraModel', () => {
  test('Claude API', () => {
    expect(
      toMastraModel({
        provider: 'ANTHROPIC',
        model: 'claude-opus-5-5',
        apiKey: 'k',
        baseUrl: null,
      }),
    ).toEqual({ id: 'anthropic/claude-opus-5-5', apiKey: 'k' });
  });

  test('OpenAI API (incl. Codex models)', () => {
    expect(
      toMastraModel({ provider: 'OPENAI', model: 'gpt-5.3-codex', apiKey: 'k', baseUrl: null }),
    ).toEqual({ id: 'openai/gpt-5.3-codex', apiKey: 'k' });
  });

  test('custom OpenAI-compatible URL + token (9Router)', () => {
    expect(
      toMastraModel({
        provider: 'OPENAI_COMPATIBLE',
        model: 'cc/claude-opus-5-5',
        apiKey: 'tok',
        baseUrl: 'http://localhost:20128/v1',
      }),
    ).toEqual({
      providerId: 'custom',
      modelId: 'cc/claude-opus-5-5',
      url: 'http://localhost:20128/v1',
      apiKey: 'tok',
    });
  });

  test('OpenRouter: its key, its fixed route and the headers it asks for (ticket 0064)', () => {
    const previous = process.env.VORASAAN_WEB_URL;
    process.env.VORASAAN_WEB_URL = 'https://vorasaan.example.com/app/';
    try {
      expect(
        toMastraModel({
          provider: 'OPENROUTER',
          model: 'anthropic/example-model',
          apiKey: 'sk-or-k',
          baseUrl: null,
        }),
      ).toEqual({
        id: 'openrouter/anthropic/example-model',
        apiKey: 'sk-or-k',
        headers: { 'HTTP-Referer': 'https://vorasaan.example.com', 'X-Title': 'Vorasaan' },
      });
    } finally {
      if (previous === undefined) delete process.env.VORASAAN_WEB_URL;
      else process.env.VORASAAN_WEB_URL = previous;
    }
  });

  test('OpenRouter ignores a stored base URL: its URL is fixed', () => {
    const model = toMastraModel({
      provider: 'OPENROUTER',
      model: 'example/model',
      apiKey: 'k',
      baseUrl: 'http://elsewhere.test/v1',
    });
    expect(model).not.toHaveProperty('url');
  });

  test('custom provider without a URL is rejected', () => {
    expect(() =>
      toMastraModel({ provider: 'OPENAI_COMPATIBLE', model: 'm', apiKey: 'k', baseUrl: null }),
    ).toThrow('base URL');
  });
});

describe('mastraModelOf', () => {
  test("an Approved Model runs on its own provider's key and URL", () => {
    expect(
      mastraModelOf({
        name: 'qwen',
        provider: {
          provider: 'OPENAI_COMPATIBLE',
          model: 'qwen',
          apiKey: 't',
          baseUrl: 'http://x/v1',
        },
      }),
    ).toEqual({ providerId: 'custom', modelId: 'qwen', url: 'http://x/v1', apiKey: 't' });
  });

  test('an env OpenRouter model with the env key still sends the OpenRouter headers', () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    try {
      expect(mastraModelOf({ name: 'openrouter/example/model', provider: null })).toMatchObject({
        id: 'openrouter/example/model',
        apiKey: 'sk-or-env',
        headers: { 'X-Title': 'Vorasaan' },
      });
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  test('an env model without a connected provider stays a "provider/model" string', () => {
    expect(mastraModelOf({ name: 'anthropic/claude-haiku-4-5', provider: null })).toBe(
      'anthropic/claude-haiku-4-5',
    );
  });
});

describe('MastraAiPort', () => {
  test('by default it refuses a call whose model was not chosen', async () => {
    const port = new MastraAiPort();
    await expect(
      port.summarizeAttachment({ attachment: { title: 't', source: 'URL', text: 'x' } }),
    ).rejects.toThrow('No model was chosen for the AI task "summarizeAttachment"');
  });

  test('the resolver gets the model chosen for the call', async () => {
    const seen: unknown[] = [];
    const port = new MastraAiPort(async (task, chosen) => {
      seen.push([task, chosen?.approvedModelId]);
      throw new Error('stop before any network call');
    });
    const model = {
      source: 'APPROVED_MODEL' as const,
      approvedModelId: 'm1',
      integrationId: 'i1',
      provider: null,
      name: 'x',
      contextWindow: 32_000,
    };
    await expect(
      port.summarizeAttachment({ attachment: { title: 't', source: 'URL', text: 'x' } }, { model }),
    ).rejects.toThrow('stop');
    expect(seen).toEqual([['summarizeAttachment', 'm1']]);
  });

  test('resolves the model on every call, so saved settings apply without restart', async () => {
    let calls = 0;
    const port = new MastraAiPort(async () => {
      calls++;
      throw new Error('stop before any network call');
    });
    const request = { kind: 'QUESTION', title: 't', description: 'd', raiserRole: 'PO' } as const;
    await expect(port.generateChoices({ specMarkdown: '#', request, context: [] })).rejects.toThrow(
      'stop',
    );
    await expect(port.generateChoices({ specMarkdown: '#', request, context: [] })).rejects.toThrow(
      'stop',
    );
    expect(calls).toBe(2);
  });

  const chatInput = {
    scope: { kind: 'PROJECT' as const, project: { name: 'Mobile Banking' } },
    context: [],
    foundation: { brief: null, guidelines: [] },
    summary: '',
    recentMessages: [{ role: 'USER' as const, content: 'Hi' }],
    tools: [],
  };

  async function drain(stream: AsyncIterable<unknown>) {
    for await (const _ of stream) {
      // Only the error matters.
    }
  }

  test('a chat reply resolves the chat model when it starts streaming', async () => {
    const tasks: string[] = [];
    const port = new MastraAiPort(async (task) => {
      tasks.push(task);
      throw new Error('stop before any network call');
    });
    await expect(drain(port.chat(chatInput))).rejects.toThrow('stop');
    await expect(
      port.summarizeConversation({
        scope: chatInput.scope,
        summary: '',
        messages: [],
        actionCards: [],
      }),
    ).rejects.toThrow('stop');
    expect(tasks).toEqual(['chat', 'summarizeConversation']);
  });
  // Chat with tools runs against a stand-in provider in mastra-chat.test.ts.
});
