'use client';

import {
  CHAT_PROVIDER_LABEL,
  type ChatAppSettingsInput,
  type ChatAppSettingsView,
  type ChatProvider,
} from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import { saveChatAppSettings, turnOffChatApp } from '@/lib/chat-app-actions';
import { field, primaryButton, secondaryButton } from './ui';

// Settings → Chat apps (ticket 0057, Admins): turn LINE, Slack or Microsoft Teams on with
// the provider's credentials. Secrets are write-only: the form only ever shows whether one
// is set, and an empty field keeps the stored one.

type FieldSpec = { name: string; label: string; secret: boolean; hint?: string };

const FIELDS: Record<ChatProvider, FieldSpec[]> = {
  LINE: [
    { name: 'channelAccessToken', label: 'Channel access token', secret: true },
    { name: 'channelSecret', label: 'Channel secret', secret: true },
  ],
  SLACK: [
    { name: 'botToken', label: 'Bot token', secret: true, hint: 'Starts with xoxb-' },
    { name: 'signingSecret', label: 'Signing secret', secret: true },
  ],
  TEAMS: [
    { name: 'appId', label: 'Bot app id', secret: false, hint: 'The Microsoft App ID' },
    { name: 'appPassword', label: 'Bot app password', secret: true },
  ],
};

const WHERE: Record<ChatProvider, string> = {
  LINE: 'LINE Developers console → your Messaging API channel. Set its webhook URL to the address below and turn "Use webhook" on.',
  SLACK:
    'api.slack.com → your app. Subscribe to the message.im bot event at the address below, and give the bot the chat:write and im:history scopes.',
  TEAMS:
    'Azure Bot resource (multi-tenant) with the Microsoft Teams channel. Set its messaging endpoint to the address below.',
};

function ChatAppForm({ app }: { app: ChatAppSettingsView }) {
  const id = useId();
  const label = CHAT_PROVIDER_LABEL[app.provider];
  const [values, setValues] = useState<Record<string, string>>({ appId: app.appId ?? '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const input = { provider: app.provider } as Record<string, string>;
      for (const f of FIELDS[app.provider]) {
        const value = values[f.name]?.trim();
        if (value) input[f.name] = value;
      }
      const result = await saveChatAppSettings(input as unknown as ChatAppSettingsInput);
      if (result.error) setMessage({ ok: false, text: result.error });
      else {
        // Forget the typed secrets: they are stored now, and never shown again.
        setValues({ appId: input.appId ?? '' });
        setMessage({ ok: true, text: 'Saved' });
      }
    });

  const turnOff = () =>
    start(async () => {
      if (!window.confirm(`Turn ${label} off? Everyone's linked ${label} account is unlinked.`)) {
        return;
      }
      const result = await turnOffChatApp(app.provider);
      setMessage(
        result.error ? { ok: false, text: result.error } : { ok: true, text: 'Turned off' },
      );
    });

  return (
    <section aria-labelledby={`${id}-title`} className="py-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 id={`${id}-title`} className="text-lg font-semibold">
          {label}
        </h3>
        <span
          data-testid={`chat-app-state-${app.provider}`}
          className={app.enabled ? 'text-sm font-semibold text-jade' : 'text-sm text-fg-soft'}
        >
          {app.enabled
            ? `On · ${app.linkedAccounts} ${app.linkedAccounts === 1 ? 'person' : 'people'} linked`
            : 'Off'}
        </span>
      </div>
      <p className="mt-1 text-sm text-fg-soft">{WHERE[app.provider]}</p>
      <p className="mt-2 text-sm">
        Events address: <code className="font-mono">{`<your Vorasaan API>${app.eventsPath}`}</code>
      </p>
      <form action={save} aria-label={`${label} credentials`} className="mt-4 space-y-3 max-w-xl">
        {FIELDS[app.provider].map((f) => (
          <label key={f.name} className="block">
            <span className="text-sm">{f.label}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[f.name] ?? ''}
              onChange={(e) => {
                setValues((v) => ({ ...v, [f.name]: e.target.value }));
                setMessage(undefined);
              }}
              placeholder={
                f.secret && app.secretsSet ? 'Set. Leave empty to keep it.' : (f.hint ?? '')
              }
              className={field}
            />
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button type="submit" disabled={pending} className={primaryButton}>
            {app.enabled ? `Save ${label}` : `Turn on ${label}`}
          </button>
          {app.enabled && (
            <button type="button" onClick={turnOff} disabled={pending} className={secondaryButton}>
              Turn off
            </button>
          )}
          {message && (
            <span
              role={message.ok ? 'status' : 'alert'}
              className={message.ok ? 'text-sm text-jade' : 'text-sm text-lacquer'}
            >
              {message.text}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

export function ChatAppsSettings({ apps }: { apps: ChatAppSettingsView[] }) {
  return (
    <div className="rows">
      {apps.map((app) => (
        <ChatAppForm key={app.provider} app={app} />
      ))}
    </div>
  );
}
