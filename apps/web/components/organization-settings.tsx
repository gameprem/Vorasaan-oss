'use client';

import { CHAT_LANGUAGE_LABEL, ChatLanguage } from '@vorasaan/shared';
import { useState, useTransition } from 'react';
import { saveOrganizationSettings } from '@/lib/getting-started-actions';
import { primaryButton } from './ui';
import { Select } from './ui/select';

// Settings → Organization (ticket 0063, Admins): the Organization's default language.

export function OrganizationLanguageForm({ language }: { language: ChatLanguage }) {
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
      <Select
        label="Language"
        labelClassName="font-medium"
        className="max-w-sm"
        options={ChatLanguage.options.map((lang) => ({
          id: lang,
          label: CHAT_LANGUAGE_LABEL[lang],
        }))}
        value={value}
        onChange={(lang) => {
          setMessage(undefined);
          setValue(lang as ChatLanguage);
        }}
      />
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
