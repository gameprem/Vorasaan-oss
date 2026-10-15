// A local stand-in for Anthropic's Messages API (ticket 0081): replies streamed the way
// Anthropic streams them, with cache usage and thinking tokens
// (`output_tokens_details.thinking_tokens`, billed as output). Tests point
// ANTHROPIC_BASE_URL at it; no real key or network is ever used.

type Json = Record<string, unknown>;

export type FakeAnthropicRequest = {
  path: string;
  headers: Record<string, string>;
  body: Json | null;
};

export type FakeAnthropic = {
  /** The base URL, e.g. http://localhost:1234/v1, for ANTHROPIC_BASE_URL. */
  url: string;
  requests: FakeAnthropicRequest[];
  /** The only key accepted; any other gets a 401. */
  key: string;
  /** What a structured call returns (through the `json` tool, or as text). */
  structured: unknown;
  /** The usage of every reply, in Anthropic's fields. */
  usage: Json;
  /**
   * A model's refusal of a request: the message of a 400 to answer with, or null to
   * answer. By default nothing is refused.
   */
  refuse: (body: Json) => string | null;
  stop: () => void;
};

function sse(events: [string, object][]): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

/** The stream for one reply: text, or a call of the `json` tool the AI SDK may ask for. */
function reply(content: { text: string } | { json: unknown }, usage: Json): string {
  const block =
    'text' in content
      ? {
          start: { type: 'text', text: '' },
          delta: { type: 'text_delta', text: content.text },
          stop: 'end_turn',
        }
      : {
          start: { type: 'tool_use', id: 'toolu_1', name: 'json', input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.json) },
          stop: 'tool_use',
        };
  const { output_tokens, output_tokens_details, ...start } = usage;
  return sse([
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
          usage: { ...start, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block.start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block.delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: block.stop },
        usage: { output_tokens, ...(output_tokens_details ? { output_tokens_details } : {}) },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

export function startFakeAnthropic(key: string): FakeAnthropic {
  const fake: Omit<FakeAnthropic, 'url' | 'stop'> = {
    requests: [],
    key,
    structured: { reply: 'ok' },
    usage: {
      input_tokens: 40,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 300,
      output_tokens: 90,
      output_tokens_details: { thinking_tokens: 70 },
    },
    refuse: () => null,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const text = req.method === 'POST' ? await req.text() : '';
      const body = text ? (JSON.parse(text) as Json) : null;
      fake.requests.push({ path, headers: Object.fromEntries(req.headers), body });
      if (req.method !== 'POST' || path !== '/v1/messages' || !body) {
        return new Response('not found', { status: 404 });
      }
      if (req.headers.get('x-api-key') !== fake.key) {
        return Response.json(
          { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
          { status: 401 },
        );
      }
      const refused = fake.refuse(body);
      if (refused) {
        return Response.json(
          { type: 'error', error: { type: 'invalid_request_error', message: refused } },
          { status: 400 },
        );
      }
      const format = (body.output_config as Json | undefined)?.format;
      const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
      const content = tools.some((t) => t.name === 'json')
        ? { json: fake.structured }
        : { text: format ? JSON.stringify(fake.structured) : 'Retry three times.' };
      return new Response(reply(content, fake.usage), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return Object.assign(fake, {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  });
}
