'use client';

import { type AiSettingsView, DEFAULT_MODELS } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { saveAiSettings, testAiSettings } from '@/lib/setup-actions';
import { type ProviderDraft, ProviderFields, toSettingsInput } from './provider-fields';

export function AiSettingsForm({ settings }: { settings: AiSettingsView }) {
  const [draft, setDraft] = useState<ProviderDraft>({
    provider: settings.provider ?? 'ANTHROPIC',
    model: settings.model ?? DEFAULT_MODELS.ANTHROPIC,
    baseUrl: settings.baseUrl ?? '',
    apiKey: '',
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [saving, startSave] = useTransition();
  const sameProvider = settings.provider === draft.provider;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startSave(async () => {
          const result = await saveAiSettings(toSettingsInput(draft));
          setMessage(
            result.error ? { ok: false, text: result.error } : { ok: true, text: 'Saved.' },
          );
          if (!result.error) setDraft((d) => ({ ...d, apiKey: '' }));
        });
      }}
    >
      <ProviderFields
        value={draft}
        onChange={(next) => {
          setMessage(undefined);
          setDraft(next);
        }}
        test={testAiSettings}
        keyOptional={sameProvider}
        keyHint={sameProvider ? settings.apiKeyHint : null}
      />
      <div className="mt-8 flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-ink px-5 py-2.5 font-medium text-sheet disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && (
          <p role="status" className={message.ok ? 'text-jade' : 'text-seal'}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
