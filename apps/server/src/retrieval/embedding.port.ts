// The only way server code turns text into vectors (ADR 0007). Production uses
// OpenAiCompatibleEmbeddingPort with the Organization's EMBEDDINGS settings;
// tests use FakeEmbeddingPort, so no test ever hits the network.

export interface EmbeddingPort {
  /** The model the vectors come from; stored on every chunk it embeds. */
  readonly model: string;
  /** One vector per text, in order, all of the same dimension. */
  embed(texts: string[]): Promise<number[][]>;
}

/** What an Admin sets in Settings → Embeddings. `apiKey` is decrypted, so never log it. */
export type EmbeddingConfig = { baseUrl: string; apiKey: string; model: string };

/** Builds the EmbeddingPort for a config. Tests replace it with a fake. */
export const EMBEDDING_PORT_FACTORY = Symbol('EMBEDDING_PORT_FACTORY');
export type EmbeddingPortFactory = (config: EmbeddingConfig) => EmbeddingPort;

export class EmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmbeddingError';
  }
}

/** pgvector's `vector` type holds at most 16,000 dimensions. */
export const MAX_EMBEDDING_DIMS = 16_000;

/** Throws unless `vectors` has one finite vector per text, all of one dimension. */
export function assertVectors(vectors: unknown, count: number): asserts vectors is number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new EmbeddingError(`Expected ${count} embeddings, got ${describeCount(vectors)}`);
  }
  const dims = (vectors[0] as unknown[] | undefined)?.length ?? 0;
  if (count > 0 && (dims < 1 || dims > MAX_EMBEDDING_DIMS)) {
    throw new EmbeddingError(`Embeddings must have 1 to ${MAX_EMBEDDING_DIMS} dimensions`);
  }
  for (const vector of vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length !== dims ||
      !vector.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      throw new EmbeddingError('The embeddings endpoint returned a malformed vector');
    }
  }
}

function describeCount(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : 'none';
}
