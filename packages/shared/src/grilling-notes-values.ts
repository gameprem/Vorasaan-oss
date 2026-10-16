import type { GrillingNote } from './grilling-notes.ts';

// The texts of grilling-notes.ts, with no Zod (types only from the schemas), so the web pages
// that show them don't load Zod.

/** The languages the server's Grilling texts are written in. */
export type GrillingLanguage = 'en' | 'th';

/**
 * Notes that report what happened rather than speak for the AI: a client shows them
 * as quiet system notes, not as an AI reply.
 */
export function isGrillingNotice(note: GrillingNote): boolean {
  return (
    note.kind === 'ANSWERED_ELSEWHERE' ||
    note.kind === 'CLOSED' ||
    note.kind === 'WAITING' ||
    note.kind === 'BRIEF_DRAFTED'
  );
}

const ROUND = {
  en: { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' },
  th: { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' },
} as const;

/** One line of someone's answer, short enough to quote. */
export function quoteAnswer(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The server's Grilling texts, in English and Thai. */
const COPY: { [L in GrillingLanguage]: (note: GrillingNote) => string } = {
  en: (note) => {
    switch (note.kind) {
      case 'INTRO': {
        const already = note.answered ? ` ${note.answered} of them already have an answer.` : '';
        return (
          `This is your Grilling Conversation for the ${ROUND.en[note.round]} round: ${note.total} ` +
          `questions for the people holding the ${note.role} Team Role, which I'll ask one at a time.${already} ` +
          `I may ask up to ${note.maxFollowUps} follow-ups on an answer. Others holding the role may ` +
          `answer some questions too; I'll tell you when they do. ` +
          'Type "skip" (or "ข้าม") to skip a question.'
        );
      }
      case 'ASK':
        return `Question ${note.position + 1} of ${note.total}: ${note.text}`;
      case 'FOLLOW_UP':
        return note.text;
      case 'RECORDED':
        return `Thanks, I recorded your answer to question ${note.position + 1}.`;
      case 'SKIPPED':
        return `Skipped question ${note.position + 1}.`;
      case 'ANSWERED_ELSEWHERE': {
        const lead = note.hadReply
          ? `${note.by} answered question ${note.position + 1} before you finished, so your reply to it wasn't recorded.`
          : `${note.by} answered question ${note.position + 1} meanwhile, so I won't ask it here.`;
        return `${lead} Their answer: "${quoteAnswer(note.answer)}"`;
      }
      case 'WAITING': {
        const { open, role } = note;
        if (!open) return "That's all for now: every question you were asked has an answer.";
        return (
          `That's all I have for you for now. ${open} question${plural(open, ' is', 's are')} still ` +
          `waiting for an answer: ${plural(open, 'one', 'ones')} you skipped. Another holder of the ` +
          `${role} Team Role may answer ${plural(open, 'it', 'them')}, or send any message here to go back to ${plural(open, 'it', 'them')}.`
        );
      }
      case 'CLOSED': {
        const label = ROUND.en[note.round];
        if (note.reason === 'CANCELLED') {
          return 'This Grilling was cancelled, so there is nothing more to answer here.';
        }
        if (note.reason === 'ROUND_SKIPPED') {
          return `The ${label} round was skipped, so there is nothing more to answer here.`;
        }
        return `Every question has an answer now, so the ${label} round is complete. Thank you!`;
      }
      case 'BRIEF_DRAFTED':
        return (
          `The Grilling is over. I drafted a Brief Proposal for ${note.project} from everyone's ` +
          'answers. Review it below: nothing changes until you approve it.'
        );
    }
  },
  th: (note) => {
    switch (note.kind) {
      case 'INTRO': {
        const already = note.answered ? ` ตอนนี้มีคำตอบแล้ว ${note.answered} ข้อ` : '';
        return (
          `นี่คือ Grilling Conversation ของคุณสำหรับรอบ ${ROUND.th[note.round]} มีคำถาม ${note.total} ข้อ ` +
          `สำหรับผู้ที่มี Team Role ${note.role} ผมจะถามทีละข้อ${already} ` +
          `ผมอาจถามต่อได้อีกไม่เกิน ${note.maxFollowUps} ครั้งในแต่ละคำตอบ คนอื่นที่มี Role เดียวกันอาจตอบบางข้อด้วย ` +
          'ถ้ามีคนตอบผมจะบอกครับ พิมพ์ "ข้าม" (หรือ "skip") เพื่อข้ามคำถาม'
        );
      }
      case 'ASK':
        return `คำถามที่ ${note.position + 1} จาก ${note.total}: ${note.text}`;
      case 'FOLLOW_UP':
        return note.text;
      case 'RECORDED':
        return `ขอบคุณครับ บันทึกคำตอบข้อ ${note.position + 1} แล้ว`;
      case 'SKIPPED':
        return `ข้ามคำถามข้อ ${note.position + 1} แล้ว`;
      case 'ANSWERED_ELSEWHERE': {
        const lead = note.hadReply
          ? `${note.by} ตอบคำถามข้อ ${note.position + 1} ก่อนที่คุณจะตอบเสร็จ คำตอบของคุณสำหรับข้อนี้จึงไม่ได้บันทึก`
          : `${note.by} ตอบคำถามข้อ ${note.position + 1} ไปแล้ว ผมจะไม่ถามข้อนี้ที่นี่`;
        return `${lead} คำตอบของเขา: "${quoteAnswer(note.answer)}"`;
      }
      case 'WAITING':
        if (!note.open) return 'ตอนนี้หมดแล้วครับ ทุกคำถามที่ถามคุณมีคำตอบแล้ว';
        return (
          `ตอนนี้ผมไม่มีคำถามอื่นสำหรับคุณแล้ว ยังมีคำถามที่คุณข้ามไว้ ${note.open} ข้อที่รอคำตอบ ` +
          `ผู้ที่มี Team Role ${note.role} คนอื่นอาจตอบได้ หรือส่งข้อความใดก็ได้ที่นี่เพื่อกลับไปตอบ`
        );
      case 'CLOSED': {
        const label = ROUND.th[note.round];
        if (note.reason === 'CANCELLED') return 'Grilling นี้ถูกยกเลิกแล้ว จึงไม่มีอะไรต้องตอบที่นี่อีก';
        if (note.reason === 'ROUND_SKIPPED') {
          return `รอบ ${label} ถูกข้ามไปแล้ว จึงไม่มีอะไรต้องตอบที่นี่อีก`;
        }
        return `ทุกคำถามมีคำตอบแล้ว รอบ ${label} เสร็จเรียบร้อย ขอบคุณครับ!`;
      }
      case 'BRIEF_DRAFTED':
        return (
          `Grilling จบแล้วครับ ผมร่าง Brief Proposal ของ ${note.project} จากคำตอบของทุกคนแล้ว ` +
          'ตรวจดูด้านล่างได้เลย ไม่มีอะไรเปลี่ยนจนกว่าคุณจะอนุมัติ'
        );
    }
  },
};

/** One note in `lang`. */
export function grillingNoteText(note: GrillingNote, lang: GrillingLanguage = 'en'): string {
  return COPY[lang](note);
}

/** A message's notes in `lang`, one paragraph each (empty ones left out). */
export function grillingNotesText(notes: GrillingNote[], lang: GrillingLanguage = 'en'): string {
  return notes
    .map((n) => grillingNoteText(n, lang).trim())
    .filter(Boolean)
    .join('\n\n');
}
