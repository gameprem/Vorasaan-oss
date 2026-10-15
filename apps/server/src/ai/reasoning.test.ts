import { describe, expect, test } from 'bun:test';
import { toMastraModel } from './model-config.ts';
import {
  anthropicEffort,
  chooseReasoning,
  connectionTestReasoning,
  defaultReasoningLevel,
  envReasoningOverride,
  geminiThinkingConfig,
  isReasoningRefusal,
  openAiReasoningEffort,
  openRouterReasoning,
  providerOptionsOf,
  reasoningEnvOverridesFor,
  reasoningSupport,
  reasoningTargetOf,
  reasoningTargetOfChoice,
} from './reasoning.ts';

// Ticket 0081: one Reasoning Level, mapped to each provider's own control by pure functions.

describe('Gemini (thinkingLevel, or a budget on 2.5)', () => {
  test('Gemini 3 and the -latest aliases take the level', () => {
    for (const id of ['gemini-3.8-flash', 'gemini-3-pro-preview', 'gemini-flash-latest']) {
      expect(geminiThinkingConfig(id, 'LOW')).toEqual({ thinkingLevel: 'low' });
      expect(geminiThinkingConfig(id, 'MEDIUM')).toEqual({ thinkingLevel: 'medium' });
      expect(geminiThinkingConfig(id, 'HIGH')).toEqual({ thinkingLevel: 'high' });
    }
  });

  test('2.5 takes a budget: off (or Pro’s least) for low, 2048 for medium, its own for high', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash', 'LOW')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-flash-lite', 'LOW')).toEqual({ thinkingBudget: 0 });
    // 2.5 Pro can't turn thinking off: 128 is its least.
    expect(geminiThinkingConfig('gemini-2.5-pro', 'LOW')).toEqual({ thinkingBudget: 128 });
    expect(geminiThinkingConfig('gemini-2.5-flash', 'MEDIUM')).toEqual({ thinkingBudget: 2048 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'MEDIUM')).toEqual({ thinkingBudget: 2048 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'HIGH')).toBeNull();
  });

  test('Gemma and the models that do not think get nothing', () => {
    for (const id of ['gemma-3-27b-it', 'gemma-3n-e4b-it', 'gemini-2.0-flash', 'gemini-1.5-pro']) {
      for (const level of ['LOW', 'MEDIUM', 'HIGH'] as const) {
        expect(geminiThinkingConfig(id, level)).toBeNull();
      }
    }
  });
});

describe('Anthropic (effort)', () => {
  test('the models with an effort setting get it', () => {
    for (const id of [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-fable-5-1',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-6',
    ]) {
      expect(anthropicEffort(id, 'LOW')).toBe('low');
      expect(anthropicEffort(id, 'MEDIUM')).toBe('medium');
      expect(anthropicEffort(id, 'HIGH')).toBe('high');
    }
  });

  test('older models, which would refuse it, get nothing', () => {
    for (const id of [
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-haiku',
      'not-claude',
    ]) {
      expect(anthropicEffort(id, 'LOW')).toBeNull();
    }
  });
});

describe('OpenAI (reasoningEffort, reasoning models only)', () => {
  test('o-series and GPT-5 and later', () => {
    for (const id of ['o3', 'o4-mini', 'gpt-5', 'gpt-5.6-sol', 'gpt-5.3-codex', 'gpt-6']) {
      expect(openAiReasoningEffort(id, 'LOW')).toBe('low');
      expect(openAiReasoningEffort(id, 'HIGH')).toBe('high');
    }
  });

  test('non-reasoning models get nothing', () => {
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5-chat-latest', 'gpt-3.5-turbo']) {
      expect(openAiReasoningEffort(id, 'LOW')).toBeNull();
    }
  });
});

describe('OpenRouter (reasoning.effort)', () => {
  test('every model but the ones known to refuse it', () => {
    expect(openRouterReasoning('anthropic/claude-opus-5-5', 'MEDIUM')).toEqual({
      effort: 'medium',
    });
    expect(openRouterReasoning('openai/gpt-5', 'HIGH')).toEqual({ effort: 'high' });
    expect(openRouterReasoning('google/gemma-3-27b-it', 'LOW')).toBeNull();
  });
});

describe('providerOptionsOf', () => {
  const approved = (provider: 'ANTHROPIC' | 'OPENAI' | 'OPENROUTER' | 'GEMINI', model: string) =>
    toMastraModel({ provider, model, apiKey: 'k', baseUrl: null });

  test('each provider kind gets its own parameter', () => {
    expect(providerOptionsOf(approved('GEMINI', 'gemini-3.8-flash'), 'LOW')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(providerOptionsOf(approved('ANTHROPIC', 'claude-opus-5-5'), 'MEDIUM')).toEqual({
      anthropic: { effort: 'medium' },
    });
    expect(providerOptionsOf(approved('OPENAI', 'gpt-5.6-sol'), 'HIGH')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
    expect(providerOptionsOf(approved('OPENROUTER', 'anthropic/claude-opus-5-5'), 'LOW')).toEqual({
      openrouter: { reasoning: { effort: 'low' } },
    });
  });

  test('env models are mapped by their prefix', () => {
    expect(providerOptionsOf('google/gemini-3.8-flash', 'HIGH')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
    expect(providerOptionsOf('anthropic/claude-opus-5-5', 'LOW')).toEqual({
      anthropic: { effort: 'low' },
    });
    expect(providerOptionsOf('groq/some-model', 'LOW')).toBeNull();
  });

  test('nothing for an OpenAI-compatible endpoint, a model that refuses it, or no level', () => {
    expect(
      providerOptionsOf(
        { providerId: 'custom', modelId: 'gemini-3.8-flash', url: 'http://x', apiKey: 'k' },
        'HIGH',
      ),
    ).toBeNull();
    expect(providerOptionsOf('google/gemma-3-27b-it', 'LOW')).toBeNull();
    expect(providerOptionsOf('openai/gpt-4o', 'HIGH')).toBeNull();
    expect(providerOptionsOf('google/gemini-3.8-flash', null)).toBeNull();
  });
});

describe('reasoningSupport', () => {
  test('supported where some level is sent; the reason otherwise', () => {
    expect(reasoningSupport({ kind: 'GEMINI', modelId: 'gemini-2.5-pro' })).toEqual({
      supported: true,
      reason: null,
    });
    expect(reasoningSupport({ kind: 'OPENAI_COMPATIBLE', modelId: 'x' })).toEqual({
      supported: false,
      reason: 'Not supported by this provider',
    });
    expect(reasoningSupport({ kind: 'GEMINI', modelId: 'gemma-3-27b-it' })).toEqual({
      supported: false,
      reason: 'This model has no reasoning control',
    });
    expect(reasoningSupport(null).supported).toBe(false);
  });

  test('the target of a Mastra model and of a chosen model', () => {
    expect(reasoningTargetOf('openrouter/google/gemma-3')).toEqual({
      kind: 'OPENROUTER',
      modelId: 'google/gemma-3',
    });
    expect(
      reasoningTargetOf({ providerId: 'custom', modelId: 'm', url: 'u', apiKey: 'k' }),
    ).toEqual({ kind: 'OPENAI_COMPATIBLE', modelId: 'm' });
    expect(reasoningTargetOf('unknown/model')).toBeNull();
    expect(reasoningTargetOfChoice({ provider: null, name: 'google/gemini-3.8-flash' })).toEqual({
      kind: 'GEMINI',
      modelId: 'gemini-3.8-flash',
    });
    expect(
      reasoningTargetOfChoice({
        provider: { provider: 'OPENAI_COMPATIBLE', model: 'm', apiKey: 'k', baseUrl: 'http://x' },
        name: 'm',
      }),
    ).toEqual({ kind: 'OPENAI_COMPATIBLE', modelId: 'm' });
  });
});

describe('task defaults', () => {
  test('low for structured tasks and Redrafts; medium for chat, Spec from Attachments, Design Docs', () => {
    expect(defaultReasoningLevel('chat')).toBe('MEDIUM');
    expect(defaultReasoningLevel('draftSpecFromAttachments')).toBe('MEDIUM');
    expect(defaultReasoningLevel('draftDesignDoc')).toBe('MEDIUM');
    for (const task of [
      'generateChoices',
      'redraftChoices',
      'summarizeConversation',
      'summarizeAttachment',
      'redraftSpecProposal',
      'redraftDesignDoc',
      'suggestFeatures',
      'grillingQuestions',
      'grillingFollowUp',
      'draftSpecProposal',
      'checkFeatureFit',
    ] as const) {
      expect(defaultReasoningLevel(task)).toBe('LOW');
    }
  });
});

describe('the env overrides', () => {
  const gemini = { kind: 'GEMINI' as const, modelId: 'gemini-3.8-flash' };
  const claude = { kind: 'ANTHROPIC' as const, modelId: 'claude-opus-5-5' };

  test('the task’s variable, then VORASAAN_REASONING, then (Gemini only) VORASAAN_GEMINI_THINKING', () => {
    const env = {
      VORASAAN_REASONING_CHAT: 'high',
      VORASAAN_REASONING: 'medium',
      VORASAAN_GEMINI_THINKING: 'default',
    };
    expect(envReasoningOverride('chat', claude, env)).toEqual({
      value: 'HIGH',
      from: 'VORASAAN_REASONING_CHAT',
    });
    expect(envReasoningOverride('generateChoices', claude, env)).toEqual({
      value: 'MEDIUM',
      from: 'VORASAAN_REASONING',
    });
    const legacy = { VORASAAN_GEMINI_THINKING: 'default' };
    expect(envReasoningOverride('generateChoices', gemini, legacy)).toEqual({
      value: 'OFF',
      from: 'VORASAAN_GEMINI_THINKING',
    });
    expect(envReasoningOverride('generateChoices', claude, legacy)).toBeUndefined();
    expect(envReasoningOverride('chat', gemini, { VORASAAN_GEMINI_THINKING: ' HIGH ' })).toEqual({
      value: 'HIGH',
      from: 'VORASAAN_GEMINI_THINKING',
    });
    expect(envReasoningOverride('chat', gemini, { VORASAAN_REASONING: 'off' })?.value).toBe('OFF');
    // An unknown value is ignored.
    expect(envReasoningOverride('chat', gemini, { VORASAAN_REASONING: 'max' })).toBeUndefined();
  });

  test('the variables set for a Settings task', () => {
    expect(
      reasoningEnvOverridesFor('SPEC_PROPOSAL', {
        VORASAAN_REASONING_REDRAFT_SPEC_PROPOSAL: 'low',
        VORASAAN_REASONING_CHAT: 'high',
        VORASAAN_REASONING: 'medium',
      }),
    ).toEqual(['VORASAAN_REASONING_REDRAFT_SPEC_PROPOSAL', 'VORASAAN_REASONING']);
    expect(reasoningEnvOverridesFor('CHAT', { VORASAAN_REASONING: 'nonsense' })).toEqual([]);
  });
});

describe('chooseReasoning: the message, then the env, then the Admin, then the default', () => {
  const target = { kind: 'ANTHROPIC' as const, modelId: 'claude-opus-5-5' };

  test('in order', () => {
    expect(chooseReasoning({ task: 'chat', target, env: {} })).toEqual({
      level: 'MEDIUM',
      source: 'DEFAULT',
    });
    expect(chooseReasoning({ task: 'chat', target, setting: 'LOW', env: {} })).toEqual({
      level: 'LOW',
      source: 'SETTINGS',
    });
    expect(
      chooseReasoning({
        task: 'chat',
        target,
        setting: 'LOW',
        env: { VORASAAN_REASONING_CHAT: 'medium' },
      }),
    ).toEqual({ level: 'MEDIUM', source: 'ENV' });
    expect(
      chooseReasoning({
        task: 'chat',
        target,
        message: 'HIGH',
        setting: 'LOW',
        env: { VORASAAN_REASONING_CHAT: 'medium' },
      }),
    ).toEqual({ level: 'HIGH', source: 'MESSAGE' });
  });

  test('off on the server sends nothing, whatever the message asks', () => {
    expect(
      chooseReasoning({
        task: 'chat',
        target,
        message: 'HIGH',
        env: { VORASAAN_REASONING: 'off' },
      }),
    ).toEqual({ level: null, source: 'ENV' });
  });
});

describe('isReasoningRefusal', () => {
  const apiError = (statusCode: number, message: string) =>
    Object.assign(new Error(message), { statusCode, responseBody: JSON.stringify({ message }) });

  test('a 400 that names the thinking or effort parameter', () => {
    expect(
      isReasoningRefusal(apiError(400, 'Thinking level is not supported for this model.')),
    ).toBe(true);
    expect(
      isReasoningRefusal(apiError(400, 'output_config.effort: Extra inputs are not permitted')),
    ).toBe(true);
    expect(
      isReasoningRefusal(
        new Error('wrapped', { cause: apiError(400, 'reasoning_effort unsupported') }),
      ),
    ).toBe(true);
  });

  test('any other failure is not', () => {
    expect(isReasoningRefusal(apiError(400, 'prompt is too long'))).toBe(false);
    expect(isReasoningRefusal(apiError(500, 'thinking failed'))).toBe(false);
    expect(isReasoningRefusal(new Error('thinking'))).toBe(false);
    expect(isReasoningRefusal('nope')).toBe(false);
  });
});

describe('connectionTestReasoning', () => {
  test('LOW, unless VORASAAN_REASONING (or, on Gemini, VORASAAN_GEMINI_THINKING) says otherwise', () => {
    const gemini = { kind: 'GEMINI' as const, modelId: 'gemini-3.8-flash' };
    const claude = { kind: 'ANTHROPIC' as const, modelId: 'claude-opus-5-5' };
    expect(connectionTestReasoning(claude, {})).toBe('LOW');
    expect(connectionTestReasoning(claude, { VORASAAN_REASONING: 'high' })).toBe('HIGH');
    expect(connectionTestReasoning(gemini, { VORASAAN_GEMINI_THINKING: 'default' })).toBeNull();
    expect(connectionTestReasoning(claude, { VORASAAN_GEMINI_THINKING: 'default' })).toBe('LOW');
  });
});
