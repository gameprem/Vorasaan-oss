import type { EmbeddingConfig, EmbeddingPort, EmbeddingPortFactory } from './embedding.port.ts';

/**
 * Deterministic stand-in for tests: a hashed bag of words, normalized. Texts that
 * share words point the same way, so "the relevant chunk comes first" is a real
 * assertion without any model. Very common words are ignored.
 */
export class FakeEmbeddingPort implements EmbeddingPort {
  constructor(
    readonly model = 'fake-embedding',
    private readonly control = new FakeEmbeddings(),
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.control.calls.push({ model: this.model, texts });
    if (this.control.failWith) throw this.control.failWith;
    return texts.map((text) => fakeEmbedding(text, this.control.dims));
  }
}

/** Test control over every FakeEmbeddingPort the factory builds. */
export class FakeEmbeddings {
  dims = 256;
  /** Set to make every call fail, e.g. to show a provider outage never fails an action. */
  failWith: Error | null = null;
  readonly calls: { model: string; texts: string[] }[] = [];
  /** Configs the factory was called with, decrypted key included: assert, never print. */
  readonly configs: EmbeddingConfig[] = [];

  readonly factory: EmbeddingPortFactory = (config) => {
    this.configs.push(config);
    return new FakeEmbeddingPort(config.model, this);
  };

  reset(): void {
    this.dims = 256;
    this.failWith = null;
    this.calls.length = 0;
    this.configs.length = 0;
  }
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'we',
  'what',
  'when',
  'with',
]);

export function fakeEmbedding(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOP_WORDS.has(word)) continue;
    const hash = fnv1a(word);
    vector[hash % dims] = (vector[hash % dims] ?? 0) + ((hash >>> 16) & 1 ? 1 : -1);
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    // Cosine distance is undefined for a zero vector: use a fixed direction instead.
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
