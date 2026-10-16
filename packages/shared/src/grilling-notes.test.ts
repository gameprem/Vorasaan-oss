import { describe, expect, test } from 'bun:test';
import type { GrillingNote } from './grilling-notes.ts';
import { grillingNotesText, grillingNoteText, isGrillingNotice } from './grilling-notes-values.ts';

const EVERY: GrillingNote[] = [
  { kind: 'INTRO', round: 'BUSINESS', role: 'PO', total: 4, answered: 1, maxFollowUps: 2 },
  { kind: 'ASK', position: 1, total: 4, text: 'Who are the target users?' },
  { kind: 'FOLLOW_UP', number: 1, text: 'ลูกค้ากลุ่มไหนครับ' },
  { kind: 'RECORDED', position: 0 },
  { kind: 'SKIPPED', position: 2 },
  { kind: 'ANSWERED_ELSEWHERE', position: 0, by: 'Nok', answer: 'Grow.', hadReply: true },
  { kind: 'WAITING', role: 'PO', open: 2 },
  { kind: 'WAITING', role: 'PO', open: 0 },
  { kind: 'CLOSED', round: 'UX', reason: 'COMPLETE' },
  { kind: 'CLOSED', round: 'UX', reason: 'ROUND_SKIPPED' },
  { kind: 'CLOSED', round: 'UX', reason: 'CANCELLED' },
  { kind: 'BRIEF_DRAFTED', project: 'Mobile Banking' },
];

describe('Grilling Notes (0047)', () => {
  test('every note has an English and a Thai text; only the AI-written follow-up stays as written', () => {
    for (const note of EVERY) {
      const en = grillingNoteText(note, 'en');
      const th = grillingNoteText(note, 'th');
      expect(en.length).toBeGreaterThan(0);
      expect(th.length).toBeGreaterThan(0);
      if (note.kind === 'FOLLOW_UP') expect(th).toBe(en);
      else expect(th).not.toBe(en);
    }
  });

  test('the English texts are the ones 0044 wrote', () => {
    expect(grillingNoteText(EVERY[1] as GrillingNote)).toBe(
      'Question 2 of 4: Who are the target users?',
    );
    expect(grillingNoteText(EVERY[5] as GrillingNote)).toBe(
      `Nok answered question 1 before you finished, so your reply to it wasn't recorded. Their answer: "Grow."`,
    );
    expect(grillingNoteText(EVERY[8] as GrillingNote)).toBe(
      'Every question has an answer now, so the UX round is complete. Thank you!',
    );
    expect(grillingNotesText([EVERY[3], EVERY[1]] as GrillingNote[])).toBe(
      'Thanks, I recorded your answer to question 1.\n\nQuestion 2 of 4: Who are the target users?',
    );
  });

  test('Thai keeps the question, the names and the numbers', () => {
    expect(grillingNoteText(EVERY[1] as GrillingNote, 'th')).toBe(
      'คำถามที่ 2 จาก 4: Who are the target users?',
    );
    expect(grillingNoteText(EVERY[5] as GrillingNote, 'th')).toContain('Nok ตอบคำถามข้อ 1');
    expect(grillingNoteText(EVERY[11] as GrillingNote, 'th')).toContain('Mobile Banking');
  });

  test("Thai keeps the domain terms, and quotes a person's words as they wrote them (0068)", () => {
    const quoted: GrillingNote = {
      kind: 'ANSWERED_ELSEWHERE',
      position: 0,
      by: 'สมชาย',
      answer: 'เพิ่ม MAU เป็น 1.5M ภายใน Q4 "ไม่รวม B2B"',
      hadReply: false,
    };
    for (const lang of ['en', 'th'] as const) {
      expect(grillingNoteText(quoted, lang)).toContain('"เพิ่ม MAU เป็น 1.5M ภายใน Q4 "ไม่รวม B2B""');
      expect(grillingNoteText(quoted, lang)).toContain('สมชาย');
    }
    const intro = grillingNoteText(EVERY[0] as GrillingNote, 'th');
    expect(intro).toContain('Grilling Conversation');
    expect(intro).toContain('Team Role PO');
    expect(grillingNoteText(EVERY[11] as GrillingNote, 'th')).toContain('Brief Proposal');
    expect(grillingNoteText(EVERY[10] as GrillingNote, 'th')).toContain('Grilling');
  });

  test('notices are the notes that report rather than ask', () => {
    expect(EVERY.filter(isGrillingNotice).map((n) => n.kind)).toEqual([
      'ANSWERED_ELSEWHERE',
      'WAITING',
      'WAITING',
      'CLOSED',
      'CLOSED',
      'CLOSED',
      'BRIEF_DRAFTED',
    ]);
  });
});
