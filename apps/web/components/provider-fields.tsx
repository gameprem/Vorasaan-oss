'use client';

import {
  type AiProvider,
  type AiSettingsInput,
  type AiTestResult,
  DEFAULT_MODELS,
  type ProviderModelsView,
} from '@vorasaan/shared';
import { useCallback, useState, useTransition } from 'react';
import { inputClass } from './login-form';
import { ProviderModelPicker } from './provider-model-picker';
import { Radio, RadioGroup } from './ui/radio-group';

export const PROVIDERS: { value: AiProvider; label: string; hint: string; keyLabel: string }[] = [
  {
    value: 'ANTHROPIC',
    label: 'Claude API',
    hint: 'An Anthropic API key from console.anthropic.com.',
    keyLabel: 'Anthropic API key',
  },
  {
    value: 'OPENAI',
    label: 'OpenAI API',
    hint: 'An OpenAI API key. Works with GPT and Codex models.',
    keyLabel: 'OpenAI API key',
  },
  {
    value: 'OPENAI_COMPATIBLE',
    label: 'Custom URL',
    hint: 'Any OpenAI-compatible endpoint with a token, such as 9Router.',
    keyLabel: 'Token',
  },
  {
    value: 'OPENROUTER',
    label: 'OpenRouter',
    hint: 'An OpenRouter API key from openrouter.ai: one key for models from many providers.',
    keyLabel: 'OpenRouter API key',
  },
  {
    value: 'GEMINI',
    label: 'Gemini API',
    hint: 'A Gemini API key from Google AI Studio (aistudio.google.com).',
    keyLabel: 'Gemini API key',
  },
];

type ModelList = { providerName: string; exampleId: string };
const OPENROUTER_LIST: ModelList = {
  providerName: 'OpenRouter',
  exampleId: 'anthropic/model-name',
};
const GEMINI_LIST: ModelList = { providerName: 'Gemini', exampleId: 'gemini-model-name' };

/**
 * The providers whose model list the picker shows (tickets 0064, 0080), with how
 * the picker names them and a model id as each spells it.
 */
export const MODEL_LISTS: Partial<Record<AiProvider, ModelList>> = {
  OPENROUTER: OPENROUTER_LIST,
  GEMINI: GEMINI_LIST,
};

/** The kinds of provider as tiles, with the picked one's hint under them. */
export function ProviderKindPicker({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: AiProvider;
  onChange: (kind: AiProvider) => void;
}) {
  const current = PROVIDERS.find((p) => p.value === value) ?? PROVIDERS[0];
  return (
    <RadioGroup
      label={label}
      name={name}
      value={value}
      onChange={(kind) => onChange(kind as AiProvider)}
      description={current?.hint}
    >
      <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {PROVIDERS.map((p) => (
          <Radio
            key={p.value}
            value={p.value}
            variant="bare"
            className="cursor-pointer rounded-card bg-bg px-3 py-2.5 font-medium data-[hovered]:bg-surface-hi data-[selected]:bg-ink-wash data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
          >
            {p.label}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

export type ProviderDraft = {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export function toSettingsInput(d: ProviderDraft): AiSettingsInput {
  const apiKey = d.apiKey.trim() || undefined;
  return d.provider === 'OPENAI_COMPATIBLE'
    ? { provider: d.provider, model: d.model.trim(), baseUrl: d.baseUrl.trim(), apiKey }
    : { provider: d.provider, model: d.model.trim(), apiKey };
}

/**
 * Pick a provider, fill in model / URL / key, and test the connection.
 * `keyOptional` is for editing saved settings, where a blank key keeps the stored one.
 */
export function ProviderFields({
  value,
  onChange,
  test,
  keyOptional = false,
  keyHint,
  loadOpenRouterModels,
  loadGeminiModels,
}: {
  value: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  test: (input: AiSettingsInput) => Promise<AiTestResult>;
  keyOptional?: boolean;
  keyHint?: string | null;
  /** OpenRouter's model list (ticket 0064); without it, the model id is typed. */
  loadOpenRouterModels?: () => Promise<ProviderModelsView>;
  /**
   * The Gemini API's model list for a key (ticket 0080); without it, the model id is
   * typed. It lists models only for a key, so it loads when asked, with the key typed.
   */
  loadGeminiModels?: (apiKey: string) => Promise<ProviderModelsView>;
}) {
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [testing, startTest] = useTransition();
  /** The key the Gemini list was asked for with; null until "Load Gemini models". */
  const [geminiListKey, setGeminiListKey] = useState<string | null>(null);
  const loadGemini = useCallback(
    () => loadGeminiModels?.(geminiListKey ?? '') ?? Promise.resolve({ models: [], error: null }),
    [loadGeminiModels, geminiListKey],
  );
  const current = PROVIDERS.find((p) => p.value === value.provider) ?? PROVIDERS[0];

  const set = (patch: Partial<ProviderDraft>) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };

  return (
    <div>
      <ProviderKindPicker
        label="Provider"
        name="provider"
        value={value.provider}
        onChange={(provider) => {
          setGeminiListKey(null);
          set({ provider, model: DEFAULT_MODELS[provider], apiKey: '' });
        }}
      />

      {value.provider === 'OPENAI_COMPATIBLE' && (
        <label className="mt-5 block">
          <span className="text-sm">Base URL</span>
          <input
            value={value.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="http://localhost:20128/v1"
            className={inputClass}
          />
        </label>
      )}

      {value.provider === 'OPENROUTER' && loadOpenRouterModels && (
        <div className="mt-5">
          <ProviderModelPicker
            {...OPENROUTER_LIST}
            load={loadOpenRouterModels}
            selectedId={value.model}
            onPick={(m) => set({ model: m.id })}
            inputClass={inputClass}
          />
        </div>
      )}

      <label className="mt-5 block">
        <span className="text-sm">Model</span>
        <input
          value={value.model}
          onChange={(e) => set({ model: e.target.value })}
          placeholder={
            value.provider === 'OPENAI_COMPATIBLE'
              ? 'The model name your endpoint expects'
              : value.provider === 'OPENROUTER' ||
                  (value.provider === 'GEMINI' && geminiListKey !== null)
                ? 'Pick one above, or type its id'
                : value.provider === 'GEMINI'
                  ? 'e.g. gemini-model-name, or load the list below'
                  : ''
          }
          className={inputClass}
        />
      </label>

      <label className="mt-5 block">
        <span className="text-sm">
          {current?.keyLabel}
          {keyOptional && keyHint ? (
            <span className="text-fg-soft">
              {' '}
              (saved key ends in {keyHint.replace('…', '')}; leave blank to keep it)
            </span>
          ) : null}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={value.apiKey}
          onChange={(e) => {
            // A Gemini list loaded with another key is stale: load it again.
            setGeminiListKey(null);
            set({ apiKey: e.target.value });
          }}
          className={inputClass}
        />
      </label>

      {value.provider === 'GEMINI' && loadGeminiModels && (
        <div className="mt-5">
          {geminiListKey === null ? (
            <button
              type="button"
              disabled={!value.apiKey.trim()}
              onClick={() => setGeminiListKey(value.apiKey.trim())}
              className="rounded-full bg-surface px-4 py-2 font-semibold text-fg hover:bg-surface-hi disabled:opacity-40"
            >
              Load Gemini models
            </button>
          ) : (
            <ProviderModelPicker
              key={geminiListKey}
              {...GEMINI_LIST}
              load={loadGemini}
              selectedId={value.model}
              onPick={(m) => set({ model: m.id })}
              inputClass={inputClass}
            />
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={testing}
          onClick={() => startTest(async () => setResult(await test(toSettingsInput(value))))}
          className="rounded-full bg-surface px-4 py-2 font-semibold text-fg hover:bg-surface-hi disabled:opacity-40"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <p role="status" className={result.ok ? 'text-jade' : 'text-lacquer'}>
            {result.ok
              ? `${result.message} (${((result.latencyMs ?? 0) / 1000).toFixed(1)}s)`
              : result.message}
          </p>
        )}
      </div>
    </div>
  );
}
