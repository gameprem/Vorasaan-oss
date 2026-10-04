// Manual eval: runs sample Decision Requests against the real model so a human can
// judge Choice quality. Not part of `bun run test`. Needs ANTHROPIC_API_KEY.
//   bun run eval:choices
//   bun run eval:choices -- --english-first   (ticket 0068's comparison)
//
// The Thai and mixed Thai-English samples (ticket 0068) are checked automatically
// too: Choices in the reply language, with the Feature names, ids, numbers and the
// quoted words kept exactly (see eval-language.ts).
import { SEED_SPEC_V1 } from '@vorasaan/db/seed';
import { loadAiConfig } from '../src/ai/ai.config.ts';
import type { RequestForAi } from '../src/ai/ai.port.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  type LanguageExpectation,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

type Sample = { request: RequestForAi; lang?: LanguageExpectation };

const samples: Sample[] = [
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

const config = loadAiConfig();
if (config.generateChoicesModel.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(async () => config.generateChoicesModel, LANGUAGE_STRATEGY);
console.log(`Model: ${config.generateChoicesModel}\n${languageBanner()}\n`);

for (const { request, lang } of samples) {
  const started = performance.now();
  const result = await ai.generateChoices(
    { specMarkdown: SEED_SPEC_V1, request, context: [] },
    { language: lang?.language },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`━━ [${request.kind}] ${request.title}  (${seconds}s)`);
  console.log(`   suggested decider: ${result.suggestedRole}`);
  for (const c of result.choices) {
    console.log(`\n   ${c.label}. ${c.title}\n      ${c.description}`);
    console.log(
      `      scope: ${c.impactScope}\n      time:  ${c.impactTime}\n      risk:  ${c.impactRisk}`,
    );
  }
  console.log('\n');
  if (lang) checkLanguage(request.title, result, lang);
}

printLanguageSummary('eval:choices');
