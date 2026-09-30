import { describe, expect, test } from 'bun:test';
import { MastraAiPort } from './mastra-ai.port.ts';
import { toMastraModel } from './model-config.ts';

describe('toMastraModel', () => {
  test('Claude API', () => {
    expect(
      toMastraModel({
        provider: 'ANTHROPIC',
        model: 'claude-opus-5-5',
        apiKey: 'k',
        baseUrl: null,
      }),
    ).toEqual({ id: 'anthropic/claude-opus-5-5', apiKey: 'k' });
  });

  test('OpenAI API (incl. Codex models)', () => {
    expect(
      toMastraModel({ provider: 'OPENAI', model: 'gpt-5.3-codex', apiKey: 'k', baseUrl: null }),
    ).toEqual({ id: 'openai/gpt-5.3-codex', apiKey: 'k' });
  });

  test('custom OpenAI-compatible URL + token (9Router)', () => {
    expect(
      toMastraModel({
        provider: 'OPENAI_COMPATIBLE',
        model: 'cc/claude-opus-5-5',
        apiKey: 'tok',
        baseUrl: 'http://localhost:20128/v1',
      }),
    ).toEqual({
      providerId: 'custom',
      modelId: 'cc/claude-opus-5-5',
      url: 'http://localhost:20128/v1',
      apiKey: 'tok',
    });
  });

  test('custom provider without a URL is rejected', () => {
    expect(() =>
      toMastraModel({ provider: 'OPENAI_COMPATIBLE', model: 'm', apiKey: 'k', baseUrl: null }),
    ).toThrow('base URL');
  });
});

describe('MastraAiPort', () => {
  test('resolves the model on every call, so saved settings apply without restart', async () => {
    let calls = 0;
    const port = new MastraAiPort(async () => {
      calls++;
      throw new Error('stop before any network call');
    });
    const request = { kind: 'QUESTION', title: 't', description: 'd', raiserRole: 'PO' } as const;
    await expect(
      port.generateChoices({ specMarkdown: '#', request, attachments: [] }),
    ).rejects.toThrow('stop');
    await expect(
      port.generateChoices({ specMarkdown: '#', request, attachments: [] }),
    ).rejects.toThrow('stop');
    expect(calls).toBe(2);
  });
});
