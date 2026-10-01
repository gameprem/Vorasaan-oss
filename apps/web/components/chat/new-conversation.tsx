'use client';

import type { AiModelsView, ConversationScopeView } from '@vorasaan/shared';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { Lang } from '@/lib/lang';
import { scopeKey } from '@/lib/scope-key';
import { Chat } from './chat';

// A new Conversation (ADR 0008): a greeting in the person's language and starter cards from
// their real pending work. Picking a Project or Feature (or starting inside one) turns the
// starters into chips above the composer. The first message creates the Conversation.

export type { Lang };

export type Starter = {
  text: string;
  /** Where it belongs, under the text. */
  sub: string;
  tag?: string;
  /** Picking it opens the composer in this scope with `text`; or it goes to `href`. */
  scope?: ConversationScopeView;
  href?: string;
};

export type ScopeOption = {
  value: string;
  label: string;
  group: string;
  scope: ConversationScopeView;
};

const COPY = {
  en: {
    hello: (name: string) => `Hello ${name}`,
    sub: 'What should we draft today?',
    nothing: 'Nothing waits for you right now. Pick a Project or Feature below and ask anything.',
    inScope: (name: string) =>
      `Ask about ${name}, or pick a suggestion below. The AI reads its context and only proposes.`,
    placeholder: 'Tell Vorasaan what you need…',
  },
  th: {
    hello: (name: string) => `สวัสดี ${name}`,
    sub: 'วันนี้ให้ช่วยร่างอะไรดี',
    nothing: 'ตอนนี้ไม่มีงานรอคุณอยู่ เลือก Project หรือ Feature ด้านล่างแล้วถามได้เลย',
    inScope: (name: string) =>
      `ถามเรื่อง ${name} หรือเลือกจากคำแนะนำด้านล่าง AI อ่าน context แล้วเสนอเท่านั้น`,
    placeholder: 'บอก Vorasaan ว่าต้องการอะไร…',
  },
} as const;

export function NewConversation({
  me,
  lang,
  options,
  initialScope,
  starters,
  chipsFor,
  models,
}: {
  me: { id: string; name: string };
  lang: Lang;
  options: ScopeOption[];
  initialScope: ConversationScopeView | null;
  starters: Starter[];
  /** The chips of each scope, by `scopeKey`. */
  chipsFor: Record<string, string[]>;
  /** The Approved Models for the composer's model menu. */
  models: AiModelsView;
}) {
  const pickerId = useId();
  const [scope, setScope] = useState<ConversationScopeView | null>(initialScope);
  const copy = COPY[lang];
  const firstName = me.name.trim().split(/\s+/)[0] ?? me.name;
  const key = scope ? scopeKey(scope) : null;
  // Inside a scope, its starters become chips, then the scope's own suggestions.
  const chips = key
    ? [
        ...starters.filter((s) => s.scope && scopeKey(s.scope) === key).map((s) => s.text),
        ...(chipsFor[key] ?? []),
      ].slice(0, 4)
    : [];
  const scopeName = scope
    ? scope.kind === 'FEATURE'
      ? scope.feature.title
      : scope.project.name
    : null;
  const groups = [...new Set(options.map((o) => o.group))];

  const picker = (
    <>
      <label htmlFor={pickerId} className="sr-only">
        Project or Feature
      </label>
      <select
        id={pickerId}
        value={key ?? ''}
        onChange={(e) => setScope(options.find((o) => o.value === e.target.value)?.scope ?? null)}
      >
        <option value="">Pick a Project or Feature…</option>
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {options
              .filter((o) => o.group === group)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </>
  );

  return (
    <Chat
      me={me}
      initial={null}
      scope={scope}
      doc={null}
      chips={chips}
      placeholder={copy.placeholder}
      context={picker}
      models={models}
      sendDisabled={scope ? undefined : 'Pick a Project or Feature first.'}
      empty={(fill) => (
        <section className="hello" aria-labelledby={`${pickerId}-hello`}>
          <h1 id={`${pickerId}-hello`} lang={lang}>
            <span className="grad">{copy.hello(firstName)}</span>
            <span className="sub">{copy.sub}</span>
          </h1>
          {scopeName ? (
            <p className="none" lang={lang}>
              {copy.inScope(scopeName)}
            </p>
          ) : starters.length === 0 ? (
            <p className="none" lang={lang}>
              {copy.nothing}
            </p>
          ) : (
            <ul className="starters" aria-label="Starters from your pending work">
              {starters.map((s) => (
                <li key={`${s.text}-${s.sub}`} className="contents">
                  {s.href ? (
                    <Link href={s.href} className="starter" lang={lang} prefetch={false}>
                      {s.tag && <span className="tag">{s.tag}</span>}
                      <span>{s.text}</span>
                      <small>{s.sub}</small>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="starter"
                      lang={lang}
                      onClick={() => {
                        if (s.scope) setScope(s.scope);
                        fill(s.text);
                      }}
                    >
                      {s.tag && <span className="tag">{s.tag}</span>}
                      <span>{s.text}</span>
                      <small>{s.sub}</small>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    />
  );
}
