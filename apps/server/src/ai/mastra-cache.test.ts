import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { ChatChunk, ContextBlock, GuidelineForAi, RequestForAi } from './ai.port.ts';
import { MastraAiPort } from './mastra-ai.port.ts';
import type { MastraModel } from './model-config.ts';
import { chatPrompt, generateChoicesPrompt } from './prompts.ts';

// Ticket 0061: MastraAiPort against local stand-ins for the Anthropic Messages
// API and an OpenAI-compatible provider. Anthropic gets the stable prefix marked
// with cache_control and the volatile rest unmarked; the other provider gets the
// very same text, as one message, with no marks.

type Json = Record<string, unknown>;

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

/**
 * The Anthropic Messages API's stream for one reply, with cache usage: text, or
 * a call of the `json` tool through which the AI SDK asks for a structured result.
 */
function anthropicReply(reply: { text: string } | { json: unknown }): string {
  const block =
    'text' in reply
      ? {
          start: { type: 'text', text: '' },
          delta: { type: 'text_delta', text: reply.text },
          stop: 'end_turn',
        }
      : {
          start: { type: 'tool_use', id: 'toolu_1', name: 'json', input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.json) },
          stop: 'tool_use',
        };
  const events: [string, object][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 40,
            output_tokens: 1,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 300,
          },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block.start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block.delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: block.stop }, usage: { output_tokens: 12 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

/** An OpenAI-compatible chat completion stream for one text reply. */
function openAiReply(text: string): string {
  const chunk = (c: object) =>
    `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', ...c })}\n\n`;
  return (
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

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

describe('the Anthropic adapter marks the stable prefix', () => {
  let server: ReturnType<typeof Bun.serve>;
  const bodies: Json[] = [];
  let previousBaseUrl: string | undefined;
  const port = new MastraAiPort(async () => ({ id: 'anthropic/test-model', apiKey: 'test-key' }));

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Json;
        bodies.push(body);
        const structured = Array.isArray(body.tools) && body.tools.length > 0;
        const reply = structured ? { json: CHOICES } : { text: 'Retry three times.' };
        return new Response(anthropicReply(reply), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    // Mastra's Anthropic provider reads its base URL from here.
    previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    server.stop(true);
  });

  test('a one-shot task: the instructions, Brief, Guidelines and Spec are marked; the request is not', async () => {
    bodies.length = 0;
    const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      expect(await port.generateChoices(choicesInput)).toEqual(CHOICES as never);
      // The call's cache hits are logged.
      expect(log).toHaveBeenCalledWith(
        'generate-choices: input 1840 (cache read 1500, cache write 300), output 12',
      );
    } finally {
      log.mockRestore();
    }
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      system: Json[];
      messages: { role: string; content: { text: string; cache_control?: unknown }[] }[];
    };
    // The short generic system prompt is not marked on its own.
    expect(body.system.every((s) => s.cache_control === undefined)).toBe(true);
    const [message] = body.messages;
    expect(body.messages).toHaveLength(1);
    const parts = message?.content ?? [];
    const prompt = await generateChoicesPrompt(SPEC, request, context, foundation);
    // The same text as every other provider gets, cut where the stable parts end.
    expect(parts.map((p) => p.text)).toEqual(prompt.parts);
    expect(parts.map((p) => p.cache_control)).toEqual([MARK, MARK, undefined]);
    expect(parts[0]?.text).toContain('# Brief');
    expect(parts[1]?.text).toContain('# Card freeze');
    expect(parts[2]?.text).toContain('Decided to poll.');
    expect(parts[2]?.text).toContain('No webhook from the card processor');
  });

  test('a chat turn: the system prompt is marked up to the Spec; context, summary and messages are not', async () => {
    bodies.length = 0;
    const chunks = await collect(port.chat(chatInput));
    expect(chunks).toEqual([{ type: 'text', delta: 'Retry three times.' }]);
    const body = bodies[0] as {
      system: { text: string; cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    const prompt = await chatPrompt(chatInput);
    expect(body.system.map((s) => s.text)).toEqual(prompt.parts);
    expect(body.system.map((s) => s.cache_control)).toEqual([MARK, MARK, undefined]);
    expect(body.system[0]?.text).toContain('# Brief');
    expect(body.system[1]?.text).toContain('# Card freeze');
    expect(body.system[2]?.text).toContain('Freeze cards');
    // At most four breakpoints, and none in the history or the new message.
    expect(body.messages).toHaveLength(3);
    for (const message of body.messages) {
      for (const part of message.content) expect(part.cache_control).toBeUndefined();
    }
    expect(JSON.stringify(body).match(/cache_control/g)?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

describe('other adapters send the same text as before', () => {
  let server: ReturnType<typeof Bun.serve>;
  const bodies: Json[] = [];
  let port: MastraAiPort;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Json;
        bodies.push(body);
        const text = body.response_format ? JSON.stringify(CHOICES) : 'Retry three times.';
        return new Response(openAiReply(text), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const model: MastraModel = {
      providerId: 'custom',
      modelId: 'test-model',
      url: `http://localhost:${server.port}/v1`,
      apiKey: 'test-key',
    };
    port = new MastraAiPort(async () => model);
  });

  afterAll(() => server.stop(true));

  test('a one-shot task is one user message holding the whole prompt, unmarked', async () => {
    bodies.length = 0;
    expect(await port.generateChoices(choicesInput)).toEqual(CHOICES as never);
    const messages = (bodies[0]?.messages ?? []) as { role: string; content: unknown }[];
    const prompt = await generateChoicesPrompt(SPEC, request, context, foundation);
    expect(messages.filter((m) => m.role === 'user')).toEqual([
      { role: 'user', content: prompt.text },
    ]);
    expect(JSON.stringify(bodies[0])).not.toMatch(/cache_?control/i);
  });

  test('a chat turn has one system message holding the whole system prompt, unmarked', async () => {
    bodies.length = 0;
    await collect(port.chat(chatInput));
    const messages = (bodies[0]?.messages ?? []) as { role: string; content: unknown }[];
    const prompt = await chatPrompt(chatInput);
    expect(messages.filter((m) => m.role === 'system')).toEqual([
      { role: 'system', content: prompt.text },
    ]);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(bodies[0])).not.toMatch(/cache_?control/i);
  });
});
