// A local stand-in for the Gemini API (ticket 0080): the model list and
// `streamGenerateContent`, streamed the way Gemini streams it, with implicit-cache
// usage and thinking tokens (`thoughtsTokenCount`, billed as output). Like Gemini, a Gemma
// model refuses any thinking settings. Tests point GOOGLE_BASE_URL at it; no real key or network is ever used.

type Json = Record<string, unknown>;

export type FakeGeminiRequest = {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: Json | null;
};

export type FakeGeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number | null;
  outputTokenLimit?: number | null;
  supportedGenerationMethods?: string[];
};

export type FakeGemini = {
  /** The base URL, e.g. http://localhost:1234/v1beta, for GOOGLE_BASE_URL. */
  url: string;
  requests: FakeGeminiRequest[];
  /** The models `GET /models` lists, split into pages of `pageSize`. */
  models: FakeGeminiModel[];
  pageSize: number;
  /** When set, `GET /models` answers with this status instead of the list. */
  modelsStatus: number | null;
  /** The only key accepted; any other gets Gemini's 400 that echoes it. */
  key: string;
  /** What a structured call returns (as JSON text). */
  structured: unknown;
  /** When set, a chat reply is this function call instead of text. */
  functionCall: { name: string; args: Json } | null;
  /** The usage of every reply, in Gemini's `usageMetadata` fields. */
  usage: Json;
  stop: () => void;
};

function sse(chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
}

export function startFakeGemini(key: string): FakeGemini {
  const fake: Omit<FakeGemini, 'url' | 'stop'> = {
    requests: [],
    models: [],
    pageSize: 50,
    modelsStatus: null,
    key,
    structured: { reply: 'ok' },
    functionCall: null,
    usage: {
      promptTokenCount: 2410,
      candidatesTokenCount: 12,
      thoughtsTokenCount: 30,
      totalTokenCount: 2452,
      cachedContentTokenCount: 1980,
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const text = req.method === 'POST' ? await req.text() : '';
      const body = text ? (JSON.parse(text) as Json) : null;
      fake.requests.push({
        method: req.method,
        path,
        search: url.search,
        headers: Object.fromEntries(req.headers),
        body,
      });

      const sent = req.headers.get('x-goog-api-key') ?? url.searchParams.get('key') ?? '';
      if (sent !== fake.key) {
        // Like a provider that echoes the key it refused.
        return Response.json(
          {
            error: {
              code: 400,
              message: `API key not valid: ${sent}. Please pass a valid API key.`,
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        );
      }

      if (req.method === 'GET' && path === '/v1beta/models') {
        if (fake.modelsStatus) {
          return Response.json(
            { error: { code: fake.modelsStatus, message: 'unavailable' } },
            { status: fake.modelsStatus },
          );
        }
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const page = fake.models.slice(start, start + fake.pageSize);
        const next = start + fake.pageSize;
        return Response.json({
          models: page,
          ...(next < fake.models.length ? { nextPageToken: String(next) } : {}),
        });
      }
      const match = /^\/v1beta\/models\/([^:]+):(streamGenerateContent|generateContent)$/.exec(
        path,
      );
      if (req.method !== 'POST' || !match) return new Response('not found', { status: 404 });

      const config = (body?.generationConfig ?? {}) as Json;
      if (match[1]?.startsWith('gemma-') && config.thinkingConfig) {
        return Response.json(
          {
            error: {
              code: 400,
              message: 'Thinking level is not supported for this model.',
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        );
      }
      const structured = config.responseMimeType === 'application/json';
      const parts = fake.functionCall
        ? [{ functionCall: fake.functionCall }]
        : [{ text: structured ? JSON.stringify(fake.structured) : 'Retry three times.' }];
      const candidate = { content: { role: 'model', parts }, finishReason: 'STOP', index: 0 };
      if (match[2] === 'generateContent') {
        return Response.json({ candidates: [candidate], usageMetadata: fake.usage });
      }
      return new Response(sse([{ candidates: [candidate], usageMetadata: fake.usage }]), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return Object.assign(fake, {
    url: `http://localhost:${server.port}/v1beta`,
    stop: () => server.stop(true),
  });
}
