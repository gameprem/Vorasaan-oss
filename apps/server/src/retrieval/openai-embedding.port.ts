import {
  assertVectors,
  type EmbeddingConfig,
  EmbeddingError,
  type EmbeddingPort,
} from './embedding.port.ts';

export type EmbeddingRequestOptions = {
  /** Texts per request. OpenAI accepts up to 2048; smaller batches keep requests small. */
  batchSize?: number;
  /** Per request. */
  timeoutMs?: number;
};

type EmbeddingsResponse = { data?: { index?: number; embedding?: unknown }[] };

/**
 * Any OpenAI-compatible embeddings endpoint: `POST {baseUrl}/embeddings` with
 * `{ model, input: string[] }`. The key is only ever sent to that URL: redirects
 * are refused, and it is scrubbed from any error message.
 */
export class OpenAiCompatibleEmbeddingPort implements EmbeddingPort {
  readonly model: string;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: EmbeddingConfig,
    options: EmbeddingRequestOptions = {},
  ) {
    let base: URL;
    try {
      base = new URL(config.baseUrl);
    } catch {
      throw new EmbeddingError('Enter the full base URL, e.g. https://api.openai.com/v1');
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new EmbeddingError('The base URL must start with https:// or http://');
    }
    this.url = `${base.href.replace(/\/+$/, '')}/embeddings`;
    this.model = config.model;
    this.batchSize = Math.max(1, options.batchSize ?? 64);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      vectors.push(...(await this.request(texts.slice(i, i + this.batchSize))));
    }
    assertVectors(vectors, texts.length);
    return vectors;
  }

  private async request(input: string[]): Promise<number[][]> {
    const host = new URL(this.url).host;
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ model: this.model, input }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new EmbeddingError(`${host} did not answer within ${this.timeoutMs} ms`);
      }
      throw new EmbeddingError(`Could not reach ${host}: ${this.scrub((error as Error).message)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new EmbeddingError(
        `${host} answered with a redirect (HTTP ${response.status}); check the base URL`,
      );
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new EmbeddingError(
        `${host} answered HTTP ${response.status}: ${this.scrub(providerMessage(text))}`,
      );
    }
    let body: EmbeddingsResponse;
    try {
      body = JSON.parse(text) as EmbeddingsResponse;
    } catch {
      throw new EmbeddingError(`${host} did not answer with JSON`);
    }
    const data = Array.isArray(body?.data) ? [...body.data] : [];
    data.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    const vectors = data.map((d) => d?.embedding);
    assertVectors(vectors, input.length);
    return vectors;
  }

  /** Providers sometimes echo the key back in errors. */
  private scrub(message: string): string {
    const clipped = message.length > 300 ? `${message.slice(0, 300)}…` : message;
    return this.config.apiKey ? clipped.split(this.config.apiKey).join('[key]') : clipped;
  }
}

function providerMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const error = parsed.error;
    const message =
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : null;
    if (message) return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.trim() || 'no details';
}
