'use client';

import {
  CHAT_LANGUAGE_LABEL,
  ChatLanguage,
  DEFAULT_MODELS,
  DEFAULT_RESPONSE_WINDOW_SETTINGS,
  WorkingTimeInput,
} from '@vorasaan/shared';
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  completeSetup,
  listGeminiModelsDuringSetup,
  listOpenRouterModelsDuringSetup,
  testAiDuringSetup,
} from '@/lib/setup-actions';
import { browserTimeZone } from '@/lib/time-zones';
import { inputClass } from './login-form';
import { type ProviderDraft, ProviderFields, toSettingsInput } from './provider-fields';
import { WorkingTimeFields } from './response-windows-settings';
import { Select } from './ui/select';

const STEPS = ['Your organization', 'Calendar & language', 'AI provider'] as const;
type Step = 0 | 1 | 2;

export function SetupWizard({ initialToken = '' }: { initialToken?: string }) {
  const [step, setStep] = useState<Step>(0);
  const [setupToken, setSetupToken] = useState(initialToken);
  const [org, setOrg] = useState({ organizationName: '', name: '', email: '', password: '' });
  // Response Windows count in this calendar (ticket 0063). The defaults until the browser's
  // time zone is known, after the first render, so server and browser render the same.
  const [workingTime, setWorkingTime] = useState<WorkingTimeInput>({
    timeZone: DEFAULT_RESPONSE_WINDOW_SETTINGS.timeZone,
    workingDays: [...DEFAULT_RESPONSE_WINDOW_SETTINGS.workingDays],
    workStart: DEFAULT_RESPONSE_WINDOW_SETTINGS.workStart,
    workEnd: DEFAULT_RESPONSE_WINDOW_SETTINGS.workEnd,
  });
  const [language, setLanguage] = useState<ChatLanguage>('en');
  const [provider, setProvider] = useState<ProviderDraft>({
    provider: 'ANTHROPIC',
    model: DEFAULT_MODELS.ANTHROPIC,
    baseUrl: '',
    apiKey: '',
  });
  const [error, setError] = useState<string>();
  const [finishing, startFinish] = useTransition();
  const loadOpenRouterModels = useCallback(
    () => listOpenRouterModelsDuringSetup(setupToken),
    [setupToken],
  );
  const loadGeminiModels = useCallback(
    (apiKey: string) => listGeminiModelsDuringSetup(apiKey, setupToken),
    [setupToken],
  );

  // The token came in the link from the server log: keep it out of the address bar (and so
  // out of bookmarks and screenshots) once it's in the field.
  useEffect(() => {
    if (window.location.search.includes('token=')) window.history.replaceState(null, '', '/setup');
  }, []);

  // Prefill the calendar and language from the browser: its time zone, and Thai if the
  // browser prefers it.
  useEffect(() => {
    setWorkingTime((w) => ({ ...w, timeZone: browserTimeZone() }));
    if (navigator.language.toLowerCase().startsWith('th')) setLanguage('th');
  }, []);

  const stepOneError = !setupToken.trim()
    ? 'Enter the setup token from the server log.'
    : !org.organizationName.trim()
      ? 'Name your organization.'
      : !org.name.trim()
        ? 'Enter your name.'
        : !/^\S+@\S+\.\S+$/.test(org.email)
          ? 'Enter a valid email.'
          : org.password.length < 10
            ? 'Use a password of at least 10 characters.'
            : undefined;
  const calendar = WorkingTimeInput.safeParse(workingTime);
  const stepTwoError = calendar.success ? undefined : calendar.error.issues[0]?.message;

  const finish = () =>
    startFinish(async () => {
      setError(undefined);
      const result = await completeSetup(
        {
          organizationName: org.organizationName,
          admin: { name: org.name, email: org.email, password: org.password },
          workingTime,
          language,
          ai: toSettingsInput(provider),
        },
        setupToken,
      );
      if (result?.tokenRejected) setStep(0);
      if (result?.error) setError(result.error);
    });

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-3xl font-semibold tracking-tight">Set up Vorasaan</h1>
      <p className="mt-2 text-fg-soft">Three steps, then you're in.</p>

      <ol className="mt-8 flex flex-wrap gap-2 text-sm" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={`rounded-full px-4 py-2 ${
              i === step ? 'bg-ink-wash font-semibold text-ink' : 'bg-surface text-fg-soft'
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault();
          const stepError = step === 0 ? stepOneError : step === 1 ? stepTwoError : undefined;
          if (stepError) setError(stepError);
          else if (step < 2) {
            setError(undefined);
            setStep((step + 1) as Step);
          } else finish();
        }}
      >
        {step === 0 ? (
          <div className="space-y-5">
            <label className="block">
              <span className="text-sm">Setup token</span>
              <input
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="setup-token-hint"
                className={`${inputClass} font-mono`}
              />
              <span id="setup-token-hint" className="mt-1 block text-sm text-fg-soft">
                Printed in the server log when it starts:{' '}
                <code className="font-mono">docker compose logs server</code>
              </span>
            </label>
            <label className="block">
              <span className="text-sm">Organization name</span>
              <input
                value={org.organizationName}
                onChange={(e) => setOrg({ ...org, organizationName: e.target.value })}
                placeholder="Acme Bank"
                className={inputClass}
              />
            </label>
            <p className="text-sm text-fg-soft">
              You'll be the first Admin. You can invite your team next.
            </p>
            <label className="block">
              <span className="text-sm">Your name</span>
              <input
                value={org.name}
                onChange={(e) => setOrg({ ...org, name: e.target.value })}
                autoComplete="name"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-sm">Email</span>
              <input
                type="email"
                value={org.email}
                onChange={(e) => setOrg({ ...org, email: e.target.value })}
                autoComplete="email"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-sm">Password (at least 10 characters)</span>
              <input
                type="password"
                value={org.password}
                onChange={(e) => setOrg({ ...org, password: e.target.value })}
                autoComplete="new-password"
                className={inputClass}
              />
            </label>
          </div>
        ) : step === 1 ? (
          <div className="space-y-5">
            <p className="text-fg-soft">
              Response Windows count only working time: a Decision Request sent on Friday evening
              isn't overdue on Saturday. Admins can change this later in Settings → Response
              Windows.
            </p>
            <WorkingTimeFields
              value={workingTime}
              onChange={(patch) => setWorkingTime((w) => ({ ...w, ...patch }))}
            />
            <Select
              label="Language"
              className="max-w-sm"
              description="For chat app cards and bot replies, unless someone picks their own."
              options={ChatLanguage.options.map((lang) => ({
                id: lang,
                label: CHAT_LANGUAGE_LABEL[lang],
              }))}
              value={language}
              onChange={(lang) => setLanguage(lang as ChatLanguage)}
            />
          </div>
        ) : (
          <>
            <p className="mb-6 text-fg-soft">
              Vorasaan uses this model to draft Choices and Spec changes. It becomes your first
              provider and default Approved Model; you can add more providers and models later in
              Settings → AI models.
            </p>
            <ProviderFields
              value={provider}
              onChange={setProvider}
              test={(input) => testAiDuringSetup(input, setupToken)}
              loadOpenRouterModels={loadOpenRouterModels}
              loadGeminiModels={loadGeminiModels}
            />
          </>
        )}

        {error && (
          <p role="alert" className="mt-6 text-lacquer">
            {error}
          </p>
        )}

        <div className="mt-8 flex gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={() => {
                setError(undefined);
                setStep((step - 1) as Step);
              }}
              className="rounded-full bg-surface px-5 py-2.5 font-semibold text-fg hover:bg-surface-hi"
            >
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={finishing}
            className="rounded-full bg-ink px-5 py-2.5 font-semibold text-on-ink hover:opacity-90 disabled:opacity-40"
          >
            {step < 2 ? 'Continue' : finishing ? 'Setting up…' : 'Finish setup'}
          </button>
        </div>
      </form>
    </div>
  );
}
