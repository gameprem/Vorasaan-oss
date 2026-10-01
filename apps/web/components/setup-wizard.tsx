'use client';

import { DEFAULT_MODELS } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { completeSetup, testAiDuringSetup } from '@/lib/setup-actions';
import { inputClass } from './login-form';
import { type ProviderDraft, ProviderFields, toSettingsInput } from './provider-fields';

const STEPS = ['Your organization', 'AI provider'] as const;

export function SetupWizard() {
  const [step, setStep] = useState<0 | 1>(0);
  const [org, setOrg] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [provider, setProvider] = useState<ProviderDraft>({
    provider: 'ANTHROPIC',
    model: DEFAULT_MODELS.ANTHROPIC,
    baseUrl: '',
    apiKey: '',
  });
  const [error, setError] = useState<string>();
  const [finishing, startFinish] = useTransition();

  const stepOneError = !org.organizationName.trim()
    ? 'Name your organization.'
    : !org.name.trim()
      ? 'Enter your name.'
      : !/^\S+@\S+\.\S+$/.test(org.email)
        ? 'Enter a valid email.'
        : org.password.length < 10
          ? 'Use a password of at least 10 characters.'
          : undefined;

  const finish = () =>
    startFinish(async () => {
      setError(undefined);
      const result = await completeSetup({
        organizationName: org.organizationName,
        admin: { name: org.name, email: org.email, password: org.password },
        ai: toSettingsInput(provider),
      });
      if (result?.error) setError(result.error);
    });

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-3xl font-semibold tracking-tight">Set up Vorasaan</h1>
      <p className="mt-2 text-ink-soft">Two steps, then you're in.</p>

      <ol className="mt-8 flex gap-6 border-b border-rule text-sm" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={`-mb-px border-b-2 pb-2 ${
              i === step ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft'
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
          if (step === 0) {
            if (stepOneError) setError(stepOneError);
            else {
              setError(undefined);
              setStep(1);
            }
          } else finish();
        }}
      >
        {step === 0 ? (
          <div className="space-y-5">
            <label className="block">
              <span className="text-sm">Organization name</span>
              <input
                value={org.organizationName}
                onChange={(e) => setOrg({ ...org, organizationName: e.target.value })}
                placeholder="Acme Bank"
                className={inputClass}
              />
            </label>
            <p className="text-sm text-ink-soft">
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
        ) : (
          <>
            <p className="mb-6 text-ink-soft">
              Vorasaan uses this model to draft Choices and Spec changes. It becomes your first
              provider and default Approved Model; you can add more providers and models later in
              Settings → AI models.
            </p>
            <ProviderFields value={provider} onChange={setProvider} test={testAiDuringSetup} />
          </>
        )}

        {error && (
          <p role="alert" className="mt-6 text-seal">
            {error}
          </p>
        )}

        <div className="mt-8 flex gap-3">
          {step === 1 && (
            <button
              type="button"
              onClick={() => setStep(0)}
              className="rounded-lg border border-rule px-5 py-2.5 text-ink"
            >
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={finishing}
            className="rounded-lg bg-ink px-5 py-2.5 font-medium text-sheet disabled:opacity-40"
          >
            {step === 0 ? 'Continue' : finishing ? 'Setting up…' : 'Finish setup'}
          </button>
        </div>
      </form>
    </div>
  );
}
