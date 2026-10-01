import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ChatChunk, ChatMessageForAi, ChatTool } from './ai.port.ts';
import { MastraAiPort, toAgentMessages } from './mastra-ai.port.ts';

// MastraAiPort.chat against a local stand-in for an OpenAI-compatible provider:
// the offered tools reach the model, a tool call comes back as a chunk (Mastra
// never runs it), and earlier calls and results are sent back in the chat.

type Body = { tools?: { function: { name: string } }[]; messages: Record<string, unknown>[] };

const sse = (chunks: object[]) =>
  `${chunks
    .map((c) =>
      JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', ...c }),
    )
    .map((c) => `data: ${c}\n\n`)
    .join('')}data: [DONE]\n\n`;

const toolCallReply = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me look. ' } }] },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'searchContext', arguments: '{"query":"tim' },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'eouts"}' } }] } },
    ],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
]);

const tools: ChatTool[] = [
  {
    name: 'searchContext',
    description: 'Searches the scope.',
    inputSchema: z.object({ query: z.string() }),
  },
];

const input = (recentMessages: ChatMessageForAi[], offered: ChatTool[]) => ({
  scope: { kind: 'PROJECT' as const, project: { name: 'Mobile Banking' } },
  context: [],
  foundation: { brief: null, guidelines: [] },
  summary: '',
  recentMessages,
  tools: offered,
});

describe('MastraAiPort.chat with tools', () => {
  let server: ReturnType<typeof Bun.serve>;
  const bodies: Body[] = [];
  let port: MastraAiPort;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Body);
        return new Response(toolCallReply, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    port = new MastraAiPort(async () => ({
      providerId: 'custom',
      modelId: 'test-model',
      url: `http://localhost:${server.port}/v1`,
      apiKey: 'test-key',
    }));
  });

  afterAll(() => server.stop(true));

  async function collect(stream: AsyncIterable<ChatChunk>) {
    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  test('offers the tools and yields the tool call without running it', async () => {
    bodies.length = 0;
    const chunks = await collect(
      port.chat(input([{ role: 'USER', content: 'What about timeouts?' }], tools)),
    );
    expect(chunks).toEqual([
      { type: 'text', delta: 'Let me look. ' },
      {
        type: 'tool-call',
        call: { id: 'call_1', name: 'searchContext', args: { query: 'timeouts' } },
      },
    ]);
    // One request: Mastra stops at the call instead of running a tool itself.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tools?.map((t) => t.function.name)).toEqual(['searchContext']);
  });

  test('sends earlier tool calls and their results back as tool messages', async () => {
    bodies.length = 0;
    await collect(
      port.chat(
        input(
          [
            { role: 'USER', content: 'What about timeouts?' },
            {
              role: 'ASSISTANT',
              content: 'Let me look. ',
              toolCalls: [{ id: 'call_1', name: 'searchContext', args: { query: 'timeouts' } }],
            },
            { role: 'TOOL', content: '{"ok":true,"results":[]}', toolCallId: 'call_1' },
          ],
          tools,
        ),
      ),
    );
    const messages = bodies[0]?.messages ?? [];
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'searchContext', arguments: '{"query":"timeouts"}' },
      },
    ]);
    const tool = messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'call_1' });
    expect(JSON.stringify(tool?.content)).toContain('results');
  });

  test('without tools, earlier calls and results are plain text', () => {
    const messages: ChatMessageForAi[] = [
      { role: 'USER', content: 'Q' },
      {
        role: 'ASSISTANT',
        content: '',
        toolCalls: [{ id: 'c1', name: 'searchContext', args: {} }],
      },
      { role: 'TOOL', content: 'R', toolCallId: 'c1' },
      // A result whose call was folded into the summary.
      { role: 'TOOL', content: 'Old', toolCallId: 'gone' },
    ];
    expect(toAgentMessages(messages, false)).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: '(Called the tool searchContext with {})' },
      { role: 'user', content: '(Result of an earlier tool call)\nR' },
      { role: 'user', content: '(Result of an earlier tool call)\nOld' },
    ]);
    expect(toAgentMessages(messages, true).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
  });
});
