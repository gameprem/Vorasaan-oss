// Dev only: counts the token fixture's texts with a real tokenizer and writes
// src/retrieval/token-fixture.counts.json, which the tests read (ticket 0059).
// The tests never load a tokenizer. Run after editing token-fixture.ts:
//   bun run --cwd apps/server tokens:fixture
//
// `tokens` is counted with cl100k_base (js-tiktoken): of the well-known public
// tokenizers it is the densest for Thai (about one token per character), so an
// estimate that holds against it holds for the leaner ones too. `o200k` is
// recorded alongside for comparison; it counts Thai at about 2.5 characters per token.
import { writeFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { TOKEN_SAMPLES } from '../src/retrieval/token-fixture.ts';

const cl100k = getEncoding('cl100k_base');
const o200k = getEncoding('o200k_base');

const counts: Record<string, { chars: number; tokens: number; o200k: number }> = {};
for (const sample of TOKEN_SAMPLES) {
  counts[sample.id] = {
    chars: sample.text.length,
    tokens: cl100k.encode(sample.text).length,
    o200k: o200k.encode(sample.text).length,
  };
}
const out = new URL('../src/retrieval/token-fixture.counts.json', import.meta.url);
const tokenizer = 'cl100k_base (js-tiktoken); o200k = o200k_base, for comparison';
writeFileSync(out, `${JSON.stringify({ tokenizer, counts }, null, 2)}\n`);
console.log(`Wrote ${Object.keys(counts).length} counts to ${out.pathname}`);
