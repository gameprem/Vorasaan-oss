import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { EmbeddingError } from './embedding.port.ts';
import { OpenAiCompatibleEmbeddingPort } from './openai-embedding.port.ts';

const KEY = 'sk-test-embeddings-key-1234';

type Seen = { path: string; auth: string | null; body: { model: string; input: string[] } };

describe('OpenAiCompatibleEmbeddingPort', () => {
  let provider: ReturnType<typeof Bun.serve>;
  let elsewhere: ReturnType<typeof Bun.serve>;
  let seen: Seen[];
  let elsewhereHits: number;
  let respond: (body: Seen['body']) => Response | Promise<Response>;

  const vectorFor = (text: string) => [text.length, 1, 0];

  beforeAll(() => {
    provider = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Seen['body'];
        seen.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          body,
        });
        return respond(body);
      },
    });
    elsewhere = Bun.serve({
      port: 0,
      fetch() {
        elsewhereHits++;
        return Response.json({ data: [] });
      },
    });
  });
  afterAll(() => {
    provider.stop(true);
    elsewhere.stop(true);
  });
  beforeEach(() => {
    seen = [];
    elsewhereHits = 0;
    respond = (body) =>
      Response.json({
        // Out of order on purpose: the adapter must sort by index.
        data: body.input
          .map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) }))
          .reverse(),
        model: body.model,
      });
  });

  const port = (options: { batchSize?: number; timeoutMs?: number } = {}) =>
    new OpenAiCompatibleEmbeddingPort(
      { baseUrl: `${provider.url.origin}/v1/`, apiKey: KEY, model: 'text-embed-small' },
      options,
    );

  test('posts {model, input} to {baseUrl}/embeddings with the key, in batches, keeping order', async () => {
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const vectors = await port({ batchSize: 2 }).embed(texts);

    expect(vectors).toEqual(texts.map(vectorFor));
    expect(seen.map((s) => s.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    for (const s of seen) {
      expect(s.path).toBe('/v1/embeddings');
      expect(s.auth).toBe(`Bearer ${KEY}`);
      expect(s.body.model).toBe('text-embed-small');
    }
  });

  test('no texts, no call', async () => {
    expect(await port().embed([])).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("an error status surfaces the provider's message, never the key", async () => {
    respond = () =>
      Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 });
    const error = await port()
      .embed(['x'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).toContain('Incorrect API key provided');
    expect((error as Error).message).not.toContain(KEY);
  });

  test('never follows a redirect, so the key only goes to the configured URL', async () => {
    respond = () =>
      new Response(null, { status: 307, headers: { location: `${elsewhere.url.origin}/steal` } });
    const error = await port()
      .embed(['x'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toContain('redirect');
    expect(elsewhereHits).toBe(0);
  });

  test('a malformed answer is an error', async () => {
    respond = () => Response.json({ data: [{ index: 0, embedding: ['nope'] }] });
    await expect(port().embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    respond = () => Response.json({ data: [] });
    await expect(port().embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    respond = () => new Response('<html>', { status: 200 });
    await expect(port().embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  test('times out', async () => {
    respond = async () => {
      await Bun.sleep(300);
      return Response.json({ data: [] });
    };
    const error = await port({ timeoutMs: 50 })
      .embed(['x'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toContain('did not answer');
  });

  test('only http(s) base URLs are accepted', () => {
    expect(
      () => new OpenAiCompatibleEmbeddingPort({ baseUrl: 'file:///etc', apiKey: KEY, model: 'm' }),
    ).toThrow(EmbeddingError);
  });
});
