'use client';

import { CHAT_LANGUAGE_LABEL, ChatLanguage } from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import { saveOrganizationSettings } from '@/lib/getting-started-actions';
import { field, primaryButton } from './ui';

// Settings → Organization (ticket 0063, Admins): the Organization's default language.

export function OrganizationLanguageForm({ language }: { language: ChatLanguage }) {
  const id = useId();
  const [value, setValue] = useState(language);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, run] = useTransition();

  const save = () =>
    run(async () => {
      const result = await saveOrganizationSettings({ language: value });
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: 'Saved' });
    });

  return (
    <form action={save} aria-label="Organization settings" className="space-y-4">
      <div className="max-w-sm">
        <label htmlFor={`${id}-language`} className="font-medium">
          Language
        </label>
        <select
          id={`${id}-language`}
          value={value}
          onChange={(e) => {
            setMessage(undefined);
            setValue(e.target.value as ChatLanguage);
          }}
          className={field}
        >
          {ChatLanguage.options.map((lang) => (
            <option key={lang} value={lang}>
              {CHAT_LANGUAGE_LABEL[lang]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          Save language
        </button>
        {message && (
          <span
            role={message.ok ? 'status' : 'alert'}
            className={message.ok ? 'text-sm text-fg-soft' : 'text-lacquer'}
          >
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
