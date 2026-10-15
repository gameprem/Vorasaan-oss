// A local stand-in for OpenRouter's API (ticket 0064): the model list and chat
// completions, streamed the way OpenRouter streams them, with cache usage. Tests
// point OPENROUTER_BASE_URL at it; no real key or network is ever used.

type Json = Record<string, unknown>;

export type FakeOpenRouterRequest = {
  path: string;
  headers: Record<string, string>;
  body: Json | null;
};

export type FakeOpenRouter = {
  /** The base URL, e.g. http://localhost:1234/api/v1, for OPENROUTER_BASE_URL. */
  url: string;
  requests: FakeOpenRouterRequest[];
  /** The models `GET /models` lists. */
  models: { id: string; name?: string; context_length?: number | null }[];
  /** When set, `GET /models` answers with this status instead of the list. */
  modelsStatus: number | null;
  /** The only key chat completions accept; any other gets a 401 that echoes it. */
  key: string;
  /** What a structured call returns (as JSON text). */
  structured: unknown;
  /** The usage of every reply: OpenRouter's fields, cache reads and writes included. */
  usage: Json;
  /** A model's refusal of a request (ticket 0081): the message of a 400, or null to answer. */
  refuse: (body: Json) => string | null;
  stop: () => void;
};

function sse(chunks: object[]): string {
  return `${chunks
    .map(
      (c) =>
        `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'm', ...c })}\n\n`,
    )
    .join('')}data: [DONE]\n\n`;
}

export function startFakeOpenRouter(key: string): FakeOpenRouter {
  const fake: Omit<FakeOpenRouter, 'url' | 'stop'> = {
    requests: [],
    models: [],
    modelsStatus: null,
    key,
    structured: { reply: 'ok' },
    usage: {
      prompt_tokens: 1840,
      completion_tokens: 12,
      total_tokens: 1852,
      prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 300 },
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

      if (req.method === 'GET' && path === '/api/v1/models') {
        if (fake.modelsStatus) return new Response('unavailable', { status: fake.modelsStatus });
        return Response.json({ data: fake.models });
      }
      if (req.method !== 'POST' || path !== '/api/v1/chat/completions') {
        return new Response('not found', { status: 404 });
      }
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${fake.key}`) {
        // Like a provider that echoes the key it refused.
        return Response.json(
          { error: { code: 401, message: `No auth credentials found for ${auth.slice(7)}` } },
          { status: 401 },
        );
      }
      const refused = fake.refuse(body ?? {});
      if (refused) {
        return Response.json({ error: { code: 400, message: refused } }, { status: 400 });
      }
      const structured = Boolean(body?.response_format) || Array.isArray(body?.tools);
      const content = structured ? JSON.stringify(fake.structured) : 'Retry three times.';
      if (!body?.stream) {
        return Response.json({
          id: 'gen-1',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: fake.usage,
        });
      }
      return new Response(
        sse([
          { choices: [{ index: 0, delta: { role: 'assistant', content } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: fake.usage },
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return Object.assign(fake, {
    url: `http://localhost:${server.port}/api/v1`,
    stop: () => server.stop(true),
  });
}
