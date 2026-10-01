'use client';

import {
  type ConversationMessageView,
  type GrillingConversationProgress,
  type GrillingConversationQuestion,
  type GrillingNote,
  type GrillingRoundProgress,
  grillingNoteText,
  isGrillingNotice,
} from '@vorasaan/shared';
import { Fragment } from 'react';
import type { Lang } from '@/lib/lang';
import { Spark } from '../icons';
import { GRILLING_UI } from './grilling-copy';
import { Markdown } from './markdown';

// Grilling in the chat view (ticket 0047): the round header, the questions someone else
// already answered (collapsed), and the server's Grilling Notes, shown in the reader's
// language with notices as quiet system notes rather than as the AI's voice.

const ROLE = {
  en: { PO: 'PO', DESIGNER: 'Designer', TECH_LEAD: 'Tech Lead' },
  th: { PO: 'PO', DESIGNER: 'Designer', TECH_LEAD: 'Tech Lead' },
} as const;

function roundStatus(r: GrillingRoundProgress, p: GrillingConversationProgress, lang: Lang) {
  const t = GRILLING_UI[lang];
  switch (r.status) {
    case 'ASKING':
      return p.grillingStatus === 'CANCELLED' ? t.cancelled : t.answered(r.answered, r.total);
    case 'ANSWERED':
      return `${t.complete} · ${t.answered(r.answered, r.total)}`;
    case 'SKIPPED':
      return t.skipped;
    case 'UPCOMING':
      return p.grillingStatus === 'CANCELLED' ? t.cancelled : t.upcoming;
  }
}

/** The three rounds, Business · PO, UX · Designer and Technical · Tech Lead, the current one highlighted. */
export function GrillingHeader({
  progress,
  lang,
}: {
  progress: GrillingConversationProgress;
  lang: Lang;
}) {
  const t = GRILLING_UI[lang];
  return (
    <ol className="rounds" aria-label={t.rounds} lang={lang}>
      {progress.rounds.map((r) => {
        const now = r.status === 'ASKING' && progress.grillingStatus === 'RUNNING';
        return (
          <li
            key={r.kind}
            className={now ? 'round now' : 'round'}
            aria-current={now ? 'step' : undefined}
          >
            <span className="name">
              {t.round[r.kind]} · {ROLE[lang][r.role as keyof (typeof ROLE)['en']] ?? r.role}
              {now && <span className="sr-only"> ({t.now})</span>}
            </span>
            <small className="round-status">{roundStatus(r, progress, lang)}</small>
          </li>
        );
      })}
    </ol>
  );
}

function minutesSince(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

/** Questions someone else answered: collapsed, with who answered; a click shows the answer. */
export function AnsweredByOthers({
  questions,
  meId,
  lang,
}: {
  questions: GrillingConversationQuestion[];
  meId: string;
  lang: Lang;
}) {
  const t = GRILLING_UI[lang];
  const others = questions.filter(
    (q) => q.status === 'ANSWERED' && q.answeredBy && q.answeredBy.id !== meId,
  );
  if (!others.length) return null;
  return (
    <section className="answered-list" aria-label={t.answeredByOthers} lang={lang}>
      {others.map((q) => (
        <details key={q.id} className="answered">
          <summary>
            <span className="q">
              <b>Q{q.position + 1}</b> {q.text}
            </span>
            <span className="by">
              {t.answeredBy(q.answeredBy?.name ?? '')}
              {q.answeredAt && (
                <>
                  {', '}
                  <time dateTime={q.answeredAt} suppressHydrationWarning>
                    {t.ago(minutesSince(q.answeredAt))}
                  </time>
                </>
              )}
            </span>
          </summary>
          <div className="answer">
            <p>{q.answer || t.noAnswer}</p>
            {q.followUps.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: follow-ups are fixed and ordered
              <Fragment key={i}>
                <p className="fq">
                  <span className="sr-only">{t.followUpQ}: </span>
                  {f.question}
                </p>
                <p>{f.answer}</p>
              </Fragment>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

/** Whether the message ends with a notice, so the AI's next words carry the spark again. */
export function endsWithNotice(message: Pick<ConversationMessageView, 'grillingNotes'>): boolean {
  const last = message.grillingNotes?.at(-1);
  return last ? isGrillingNotice(last) : false;
}

/** A run of notes: notices on their own, the rest spoken by the AI together. */
type Block = { notice: true; note: GrillingNote } | { notice: false; notes: GrillingNote[] };

function blocks(notes: GrillingNote[]): Block[] {
  const out: Block[] = [];
  for (const note of notes) {
    if (isGrillingNotice(note)) {
      out.push({ notice: true, note });
      continue;
    }
    const last = out.at(-1);
    if (last && !last.notice) last.notes.push(note);
    else out.push({ notice: false, notes: [note] });
  }
  return out;
}

function NoteText({ note, lang }: { note: GrillingNote; lang: Lang }) {
  if (note.kind === 'ASK') {
    const text = grillingNoteText(note, lang);
    const head = text.slice(0, text.length - note.text.length).trimEnd();
    return (
      <p className="ask">
        <b>{head}</b> {note.text}
      </p>
    );
  }
  if (note.kind === 'FOLLOW_UP') return <Markdown>{note.text}</Markdown>;
  return <p>{grillingNoteText(note, lang)}</p>;
}

/**
 * A message the server wrote in a Grilling Conversation, from its Grilling Notes: notices
 * as quiet system notes, the rest (questions, acknowledgements, follow-ups) as the AI.
 */
export function GrillingMessage({
  notes,
  first,
  lang,
}: {
  notes: GrillingNote[];
  /** The message starts the AI's turn, so its first spoken part carries the spark. */
  first: boolean;
  lang: Lang;
}) {
  const t = GRILLING_UI[lang];
  let spark = first;
  return (
    <>
      {blocks(notes).map((b, i) => {
        if (b.notice) {
          spark = true;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a stored message's notes never change
            <div key={i} className="sys-note" role="note" lang={lang}>
              <span className="sr-only">{t.note}: </span>
              {grillingNoteText(b.note, lang)}
            </div>
          );
        }
        const withSpark = spark;
        spark = false;
        const followUp = b.notes[0]?.kind === 'FOLLOW_UP' ? b.notes[0] : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a stored message's notes never change
          <div key={i} className={withSpark ? 'msg ai' : 'msg ai cont'} lang={lang}>
            {withSpark ? (
              <>
                <Spark size={28} className="spark" />
                <div className="who">
                  {followUp?.kind === 'FOLLOW_UP' ? t.followUpOf(followUp.number) : t.who}
                </div>
              </>
            ) : (
              <span className="sr-only">Vorasaan: </span>
            )}
            {b.notes.map((note, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a stored message's notes never change
              <NoteText key={j} note={note} lang={lang} />
            ))}
          </div>
        );
      })}
    </>
  );
}
