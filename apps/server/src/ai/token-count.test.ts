import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type ChatMessageForAi,
  ContextTooLongError,
  isContextTooLong,
  type ModelChoice,
} from './ai.port.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { MastraAiPort } from './mastra-ai.port.ts';
import { estimateChatTokens } from './token-count.ts';

// Counting tokens (ticket 0060): the provider's counting API where there is one,
// the script-aware estimate (0059) otherwise and whenever counting fails.

const messages: ChatMessageForAi[] = [
  { role: 'USER', content: 'เราจะรอผู้ให้บริการชำระเงินนานแค่ไหน' },
  { role: 'ASSISTANT', content: 'Up to 24 hours.', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
  { role: 'TOOL', content: '{"ok":true}', toolCallId: 'c1' },
];
const input = { system: '## Goal\n- Async checkout', messages };

function anthropicModel(baseUrl: string | null): ModelChoice {
  return {
    source: 'APPROVED_MODEL',
    approvedModelId: 'm1',
    integrationId: 'i1',
    provider: { provider: 'ANTHROPIC', model: 'claude-haiku-4-5', apiKey: 'sk-ant-x', baseUrl },
    name: 'claude-haiku-4-5',
    contextWindow: 200_000,
  };
}

describe('countTokens', () => {
  let server: ReturnType<typeof Bun.serve>;
  const requests: {
    path: string;
    body: { model: string; system?: string; messages: unknown[] };
  }[] = [];
  let fail = false;

  beforeAll(() => {
    // A stand-in for Anthropic's counting endpoint.
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as (typeof requests)[number]['body'];
        requests.push({ path: new URL(req.url).pathname, body });
        if (fail)
          return Response.json({ type: 'error', error: { type: 'api_error' } }, { status: 500 });
        return Response.json({ input_tokens: 1_234 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test('an Anthropic model is counted by its counting API, the messages as one text', async () => {
    const port = new MastraAiPort();
    const tokens = await port.countTokens(input, { model: anthropicModel(server.url.origin) });
    expect(tokens).toBe(1_234);
    const [request] = requests;
    expect(request?.path).toBe('/v1/messages/count_tokens');
    expect(request?.body.model).toBe('claude-haiku-4-5');
    expect(request?.body.system).toBe(input.system);
    expect(JSON.stringify(request?.body.messages)).toContain('person: ');
  });

  test('a failed count falls back to the estimate instead of failing the turn', async () => {
    fail = true;
    try {
      const port = new MastraAiPort();
      const tokens = await port.countTokens(input, { model: anthropicModel(server.url.origin) });
      expect(tokens).toBe(estimateChatTokens(input));
    } finally {
      fail = false;
    }
  });

  test('other providers use the script-aware estimate', async () => {
    const port = new MastraAiPort();
    const model: ModelChoice = {
      ...anthropicModel(null),
      provider: { provider: 'OPENAI_COMPATIBLE', model: 'qwen', apiKey: 'k', baseUrl: 'http://x' },
    };
    const before = requests.length;
    expect(await port.countTokens(input, { model })).toBe(estimateChatTokens(input));
    expect(requests.length).toBe(before);
    // Thai costs about a token per character (0059), far more than English per character.
    expect(estimateChatTokens({ system: '', messages: messages.slice(0, 1) })).toBeGreaterThan(30);
  });

  test("the fake's counter is deterministic, and can play a denser tokenizer", async () => {
    const fake = new FakeAiPort();
    const once = await fake.countTokens(input);
    expect(await fake.countTokens(input)).toBe(once);
    fake.tokenScale = 2;
    expect(await fake.countTokens(input)).toBe(Math.ceil(estimateChatTokens(input) * 2));
    expect(fake.tokenCounts).toHaveLength(3);
  });
});

describe('isContextTooLong', () => {
  test("recognises each provider's way of saying a request is too long", () => {
    for (const message of [
      'prompt is too long: 210000 tokens > 200000 maximum',
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      'Input is too long for requested model.',
      'the request exceeds the available context size, try increasing the context window',
      // Gemini (ticket 0080).
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    ]) {
      expect(isContextTooLong(new Error(message))).toBe(true);
    }
    expect(
      isContextTooLong(
        Object.assign(new Error('Bad request'), { code: 'context_length_exceeded' }),
      ),
    ).toBe(true);
    // Wrapped, as the AI SDK does, with the provider's body on the cause.
    const wrapped = new Error('The chat stream failed', {
      cause: Object.assign(new Error('Bad request'), {
        responseBody: '{"error":{"message":"prompt is too long"}}',
      }),
    });
    expect(isContextTooLong(wrapped)).toBe(true);
    expect(isContextTooLong(new ContextTooLongError())).toBe(true);
  });

  test('other failures are not "too long"', () => {
    for (const message of ['provider unreachable', 'Invalid API key', 'rate limited']) {
      expect(isContextTooLong(new Error(message))).toBe(false);
    }
  });
});
