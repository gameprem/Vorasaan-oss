'use client';

import {
  CHAT_EVENT_LABEL,
  CHAT_LANGUAGE_LABEL,
  CHAT_PROVIDER_LABEL,
  ChatEventKind,
  ChatLanguage,
  type ChatLinkCodeView,
  type ChatPreferencesView,
  type MyChatAppsView,
} from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { createChatLinkCode, saveChatPreferences, unlinkChatAccount } from '@/lib/chat-app-actions';
import { relativeTime } from './bits';
import { primaryButton, secondaryButton } from './ui';
import { Checkbox } from './ui/checkbox';
import { TimeField } from './ui/date-picker';
import { Select } from './ui/select';
import { TimeZoneComboBox } from './ui/time-zone-combo-box';

// Settings → Notifications (ticket 0057): link a LINE, Slack or Teams account with a
// one-time code, unlink it, and choose what goes there, when not, and in which language
// (ticket 0058).

/** While a code is shown, look for the link every few seconds (the event stream also says). */
const POLL_MS = 3_000;

function secondsLeft(expiresAt: string) {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function LinkCode({ code, onExpired }: { code: ChatLinkCodeView; onExpired: () => void }) {
  const router = useRouter();
  const label = CHAT_PROVIDER_LABEL[code.provider];
  const [left, setLeft] = useState(() => secondsLeft(code.expiresAt));
  useEffect(() => {
    const tick = setInterval(() => setLeft(secondsLeft(code.expiresAt)), 1000);
    const poll = setInterval(() => router.refresh(), POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code.expiresAt, router]);
  useEffect(() => {
    if (left === 0) onExpired();
  }, [left, onExpired]);
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, '0');
  return (
    <div className="mt-3 rounded-card bg-jade-wash p-4">
      <p className="text-sm">Send this code to the Vorasaan bot in {label}:</p>
      <output
        aria-label={`${label} link code`}
        className="mt-2 block font-mono text-3xl font-semibold tracking-widest text-fg"
      >
        {code.code}
      </output>
      <p className="mt-2 text-sm text-fg-soft">
        It works once, for {minutes}:{seconds} more. The bot answers when your account is linked.
      </p>
    </div>
  );
}

function ChatAppRow({ app }: { app: MyChatAppsView['apps'][number] }) {
  const label = CHAT_PROVIDER_LABEL[app.provider];
  const [code, setCode] = useState<ChatLinkCodeView>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const linked = app.account !== null;

  // Linked (here or from the chat side): the code has done its job.
  useEffect(() => {
    if (linked) setCode(undefined);
  }, [linked]);

  const link = () =>
    start(async () => {
      setError(undefined);
      const result = await createChatLinkCode(app.provider);
      if (result.error) setError(result.error);
      else setCode(result.code);
    });

  const unlink = () =>
    start(async () => {
      setError(undefined);
      const result = await unlinkChatAccount(app.provider);
      if (result.error) setError(result.error);
    });

  return (
    <li className="py-4" aria-label={label}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1">
          <span className="block font-medium">{label}</span>
          <span className="block text-sm text-fg-soft" data-testid={`chat-account-${app.provider}`}>
            {app.account
              ? `Linked${app.account.displayName ? ` as ${app.account.displayName}` : ''} ${relativeTime(app.account.linkedAt)}`
              : 'Not linked'}
          </span>
        </span>
        {linked ? (
          <button type="button" onClick={unlink} disabled={pending} className={secondaryButton}>
            Unlink {label}
          </button>
        ) : (
          <button type="button" onClick={link} disabled={pending} className={primaryButton}>
            {code ? 'New code' : `Link ${label}`}
          </button>
        )}
      </div>
      {!linked && code && <LinkCode code={code} onExpired={() => setCode(undefined)} />}
      {error && (
        <p role="alert" className="mt-2 text-lacquer">
          {error}
        </p>
      )}
    </li>
  );
}

function PreferencesForm({
  preferences,
  organizationTimeZone,
  organizationLanguage,
}: {
  preferences: ChatPreferencesView;
  organizationTimeZone: string;
  organizationLanguage: ChatLanguage;
}) {
  const [events, setEvents] = useState(preferences.events);
  const [quiet, setQuiet] = useState(preferences.quietHours !== null);
  const [start, setStart] = useState(preferences.quietHours?.start ?? '22:00');
  const [end, setEnd] = useState(preferences.quietHours?.end ?? '07:00');
  const [timeZone, setTimeZone] = useState(preferences.timeZone ?? '');
  // '': the Organization's language (ticket 0063).
  const [language, setLanguage] = useState<ChatLanguage | ''>(preferences.language ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, run] = useTransition();
  const touched = () => setMessage(undefined);

  const save = () =>
    run(async () => {
      const result = await saveChatPreferences({
        events,
        quietHours: quiet ? { start, end } : null,
        timeZone: timeZone || null,
        language: language || null,
      });
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: 'Saved' });
    });

  return (
    <form action={save} aria-label="Chat app preferences" className="space-y-6">
      <fieldset>
        <legend className="font-medium">Send to my chat apps</legend>
        <div className="mt-2 space-y-2">
          {ChatEventKind.options.map((kind) => (
            <Checkbox
              key={kind}
              isSelected={events.includes(kind)}
              onChange={(on) => {
                touched();
                setEvents((list) => (on ? [...list, kind] : list.filter((k) => k !== kind)));
              }}
            >
              {CHAT_EVENT_LABEL[kind]}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="font-medium">Quiet hours</legend>
        <Checkbox
          className="mt-2"
          isSelected={quiet}
          onChange={(on) => {
            touched();
            setQuiet(on);
          }}
        >
          Hold cards during quiet hours: they arrive when quiet hours end, and your Inbox has them
          meanwhile
        </Checkbox>
        {quiet && (
          <div className="mt-2 flex flex-wrap gap-4">
            <TimeField
              label="From"
              value={start}
              onChange={(next) => {
                touched();
                setStart(next);
              }}
            />
            <TimeField
              label="Until"
              value={end}
              onChange={(next) => {
                touched();
                setEnd(next);
              }}
            />
          </div>
        )}
        <TimeZoneComboBox
          label="Time zone"
          className="mt-3 max-w-sm"
          emptyLabel={`The Organization's (${organizationTimeZone})`}
          value={timeZone}
          onChange={(next) => {
            touched();
            setTimeZone(next);
          }}
        />
      </fieldset>
      <Select
        label="My language"
        description="Chat cards, bot replies, your Grilling Conversations and the AI's replies to you use it."
        labelClassName="font-medium"
        className="max-w-sm"
        options={[
          { id: '', label: `The Organization's (${CHAT_LANGUAGE_LABEL[organizationLanguage]})` },
          ...ChatLanguage.options.map((lang) => ({ id: lang, label: CHAT_LANGUAGE_LABEL[lang] })),
        ]}
        value={language}
        onChange={(lang) => {
          touched();
          setLanguage(lang as ChatLanguage | '');
        }}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          Save chat preferences
        </button>
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
  );
}

export function ChatAccountsSettings({
  view,
  organizationTimeZone,
  organizationLanguage,
}: {
  view: MyChatAppsView;
  organizationTimeZone: string;
  organizationLanguage: ChatLanguage;
}) {
  const enabled = view.apps.filter((a) => a.enabled || a.account);
  return (
    <div className="space-y-10">
      <section aria-labelledby="chat-accounts">
        <h3 id="chat-accounts" className="text-lg font-semibold">
          Chat apps
        </h3>
        <p className="mt-1 text-fg-soft">
          Link your account to get Decision Requests where you already chat. Only messages from the
          linked account count as you.
        </p>
        {enabled.length ? (
          <ul className="mt-2 rows">
            {enabled.map((app) => (
              <ChatAppRow key={app.provider} app={app} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-fg-soft">
            An Admin hasn't turned on LINE, Slack or Microsoft Teams yet (Settings → Chat apps).
          </p>
        )}
      </section>
      <section aria-labelledby="chat-preferences">
        <h3 id="chat-preferences" className="text-lg font-semibold">
          What goes to chat apps
        </h3>
        <div className="mt-3">
          <PreferencesForm
            preferences={view.preferences}
            organizationTimeZone={organizationTimeZone}
            organizationLanguage={organizationLanguage}
          />
        </div>
      </section>
    </div>
  );
}
