import { MAX_GRILLING_FOLLOW_UPS } from '@vorasaan/shared';

// The chat's Grilling copy (ticket 0047), in English and Thai. Not a client module, so the
// server pages (placeholder, context line) and the chat both read it.

export const GRILLING_UI = {
  en: {
    crumb: (round: string) => `Grilling · ${round} round`,
    rounds: 'Grilling rounds',
    round: { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' },
    answered: (a: number, t: number) => `${a} of ${t} answered`,
    complete: 'Complete',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
    upcoming: 'Not reached yet',
    now: 'current round',
    answeredByOthers: 'Answered by others',
    answeredBy: (name: string) => `Answered by ${name}`,
    followUpOf: (n: number) => `Follow-up ${n} of ${MAX_GRILLING_FOLLOW_UPS}`,
    followUpQ: 'Follow-up',
    noAnswer: 'No answer text.',
    who: 'Vorasaan · Grilling',
    note: 'Note',
    skip: 'Skip this question',
    skipWord: 'skip',
    placeholder: 'Answer in your own words, or type "skip"…',
    context: 'Your answers go to the Brief Proposal, attributed to you',
    ago: (minutes: number) => {
      if (minutes < 1) return 'just now';
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} h ago`;
      return `${Math.round(hours / 24)} d ago`;
    },
  },
  th: {
    crumb: (round: string) => `Grilling · รอบ ${round}`,
    rounds: 'รอบของ Grilling',
    round: { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' },
    answered: (a: number, t: number) => `ตอบแล้ว ${a} จาก ${t} ข้อ`,
    complete: 'เสร็จแล้ว',
    skipped: 'ข้ามแล้ว',
    cancelled: 'ยกเลิกแล้ว',
    upcoming: 'ยังไม่ถึงรอบนี้',
    now: 'รอบปัจจุบัน',
    answeredByOthers: 'คนอื่นตอบแล้ว',
    answeredBy: (name: string) => `ตอบโดย ${name}`,
    followUpOf: (n: number) => `คำถามต่อเนื่อง ${n} จาก ${MAX_GRILLING_FOLLOW_UPS}`,
    followUpQ: 'คำถามต่อเนื่อง',
    noAnswer: 'ไม่มีข้อความคำตอบ',
    who: 'Vorasaan · Grilling',
    note: 'หมายเหตุ',
    skip: 'ข้ามคำถามนี้',
    skipWord: 'ข้าม',
    placeholder: 'ตอบด้วยคำของคุณเอง หรือพิมพ์ "ข้าม"…',
    context: 'คำตอบของคุณจะไปอยู่ใน Brief Proposal โดยระบุว่าเป็นของคุณ',
    ago: (minutes: number) => {
      if (minutes < 1) return 'เมื่อสักครู่';
      if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
      return `${Math.round(hours / 24)} วันที่แล้ว`;
    },
  },
} as const;
