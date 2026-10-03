import { describe, expect, test } from 'bun:test';
import { matchesSearch } from './openrouter-model-picker';

// Ticket 0064: OpenRouter's list is searchable by name and id.

const model = { id: 'anthropic/example-model', name: 'Anthropic: Example', contextWindow: 200_000 };

describe('matchesSearch', () => {
  test('matches the name or the id, case-insensitively', () => {
    expect(matchesSearch(model, '')).toBe(true);
    expect(matchesSearch(model, 'EXAMPLE')).toBe(true);
    expect(matchesSearch(model, 'anthropic/')).toBe(true);
    expect(matchesSearch(model, 'example-model')).toBe(true);
    expect(matchesSearch(model, 'other')).toBe(false);
  });

  test('every word must match, in any order', () => {
    expect(matchesSearch(model, 'example anthropic')).toBe(true);
    expect(matchesSearch(model, 'example other')).toBe(false);
  });
});
