// The samples of `bun run eval:choices` (scripts/eval-choices.ts), and the same samples as
// in-app eval cases (ticket 0071): Choices for sample Decision Requests on the seed Spec.
import { SEED_SPEC_V1 } from '@vorasaan/db/seed';
import type { RequestForAi } from '../../ai/ai.port.ts';
import { caseKey, type EvalCase } from '../eval-case.ts';
import type { LanguageExpectation } from '../language-check.ts';

export type ChoicesSample = { request: RequestForAi; lang?: LanguageExpectation };

export const CHOICES_SAMPLES: ChoicesSample[] = [
  {
    request: {
      kind: 'BLOCKER',
      raiserRole: 'BACKEND',
      title: 'Provider has no webhook for payment status',
      description:
        'The payment provider only offers a polling API (rate limit 5 req/s). The Spec assumes we get notified when a payment is confirmed.',
    },
    lang: { language: 'en' },
  },
  {
    request: {
      kind: 'QUESTION',
      raiserRole: 'BACKEND',
      title: 'How long before a pending payment counts as failed?',
      description:
        'The Spec leaves the timeout open. The provider can take up to 24h in rare cases.',
    },
  },
  {
    request: {
      kind: 'BLOCKER',
      raiserRole: 'FRONTEND',
      title: 'ปุ่ม Retry ควรอยู่ตรงไหน',
      description: 'หน้า order ตอนนี้ไม่มีพื้นที่สำหรับปุ่ม retry ถ้าใส่เพิ่มต้องเปลี่ยน layout ของการ์ด order ทั้งหมด',
    },
    lang: { language: 'th', keep: ['Retry'] },
  },
  {
    request: {
      kind: 'QUESTION',
      raiserRole: 'QA',
      title: 'What counts as "under 1 second"?',
      description:
        'Is it measured on the device from tap to screen change, or server response time?',
    },
    lang: { language: 'en' },
  },
  // Ticket 0068: Thai with a quote, an id and numbers that must survive.
  {
    request: {
      kind: 'QUESTION',
      raiserRole: 'QA',
      title: 'ลูกค้าเห็นสถานะผิดหลังจ่ายเงิน',
      description:
        'ตาม PAY-142 ลูกค้าบอกว่า "จ่ายแล้วแต่แอปยังขึ้นว่ารอชำระ" นานเกิน 10 นาที ' +
        'Spec ของ Feature "Async checkout" ไม่ได้บอกว่าต้องแสดงอะไรระหว่างรอ',
    },
    lang: {
      language: 'th',
      keep: ['PAY-142', '10 นาที', 'Async checkout'],
    },
  },
  // Mixed Thai-English, the way Thai engineers write: English terms in Thai sentences.
  {
    request: {
      kind: 'BLOCKER',
      raiserRole: 'BACKEND',
      title: 'PayFast webhook ไม่มี signature',
      description:
        'PayFast SDK 4.2 ส่ง webhook มาแบบไม่มี HMAC signature เลย verify ไม่ได้ ' +
        'ถ้าจะ poll แทนติด rate limit 5 req/s ต้องให้ Tech Lead ตัดสินว่าจะเอาแบบไหน',
    },
    lang: { language: 'th', keep: ['PayFast', 'SDK 4.2', 'HMAC', '5 req/s'] },
  },
];

export const CHOICES_EVAL_CASES: EvalCase[] = CHOICES_SAMPLES.map(({ request, lang }) => ({
  key: caseKey('choices', request.title),
  set: 'choices',
  name: request.title,
  task: 'generateChoices',
  lang,
  run: (ai, options) =>
    ai.generateChoices({ specMarkdown: SEED_SPEC_V1, request, context: [] }, options),
}));
