// A local stand-in for OpenAI's Responses API (ticket 0081), which Mastra's OpenAI provider
// calls: replies streamed the way OpenAI streams them, with cached and reasoning tokens
// (`output_tokens_details.reasoning_tokens`, billed as output). Tests point OPENAI_BASE_URL
// at it; no real key or network is ever used.

type Json = Record<string, unknown>;

export type FakeOpenAiRequest = {
  path: string;
  headers: Record<string, string>;
  body: Json | null;
};

export type FakeOpenAi = {
  /** The base URL, e.g. http://localhost:1234/v1, for OPENAI_BASE_URL. */
  url: string;
  requests: FakeOpenAiRequest[];
  /** The only key accepted; any other gets a 401. */
  key: string;
  /** What a structured call returns (as JSON text). */
  structured: unknown;
  /** The usage of every reply, in the Responses API's fields. */
  usage: Json;
  /** A model's refusal of a request: the message of a 400, or null to answer. */
  refuse: (body: Json) => string | null;
  stop: () => void;
};

function sse(events: Json[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

export function startFakeOpenAi(key: string): FakeOpenAi {
  const fake: Omit<FakeOpenAi, 'url' | 'stop'> = {
    requests: [],
    key,
    structured: { reply: 'ok' },
    usage: {
      input_tokens: 2000,
      input_tokens_details: { cached_tokens: 1500 },
      output_tokens: 120,
      output_tokens_details: { reasoning_tokens: 96 },
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
      if (req.method !== 'POST' || path !== '/v1/responses' || !body) {
        return new Response('not found', { status: 404 });
      }
      if (req.headers.get('authorization') !== `Bearer ${fake.key}`) {
        return Response.json(
          { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
          { status: 401 },
        );
      }
      const refused = fake.refuse(body);
      if (refused) {
        return Response.json(
          { error: { message: refused, type: 'invalid_request_error', param: null, code: null } },
          { status: 400 },
        );
      }
      const structured = Boolean((body.text as Json | undefined)?.format);
      const output = structured ? JSON.stringify(fake.structured) : 'Retry three times.';
      const item = { type: 'message', id: 'msg_1' };
      return new Response(
        sse([
          {
            type: 'response.created',
            response: { id: 'resp_1', created_at: 1, model: String(body.model) },
          },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: output },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { usage: fake.usage } },
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return Object.assign(fake, {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  });
}
