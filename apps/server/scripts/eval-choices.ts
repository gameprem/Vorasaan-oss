// Manual eval: runs sample Decision Requests against the real model so a human can
// judge Choice quality. Not part of `bun run test`. Needs ANTHROPIC_API_KEY.
//   bun run eval:choices
import { SEED_SPEC_V1 } from '@vorasaan/db/seed';
import { loadAiConfig } from '../src/ai/ai.config.ts';
import type { RequestForAi } from '../src/ai/ai.port.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';

const samples: RequestForAi[] = [
  {
    kind: 'BLOCKER',
    raiserRole: 'BACKEND',
    title: 'Provider has no webhook for payment status',
    description:
      'The payment provider only offers a polling API (rate limit 5 req/s). The Spec assumes we get notified when a payment is confirmed.',
  },
  {
    kind: 'QUESTION',
    raiserRole: 'BACKEND',
    title: 'How long before a pending payment counts as failed?',
    description: 'The Spec leaves the timeout open. The provider can take up to 24h in rare cases.',
  },
  {
    kind: 'BLOCKER',
    raiserRole: 'FRONTEND',
    title: 'ปุ่ม Retry ควรอยู่ตรงไหน',
    description: 'หน้า order ตอนนี้ไม่มีพื้นที่สำหรับปุ่ม retry ถ้าใส่เพิ่มต้องเปลี่ยน layout ของการ์ด order ทั้งหมด',
  },
  {
    kind: 'QUESTION',
    raiserRole: 'QA',
    title: 'What counts as "under 1 second"?',
    description: 'Is it measured on the device from tap to screen change, or server response time?',
  },
];

const config = loadAiConfig();
if (config.generateChoicesModel.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(config);
console.log(`Model: ${config.generateChoicesModel}\n`);

for (const request of samples) {
  const started = performance.now();
  const result = await ai.generateChoices({ specMarkdown: SEED_SPEC_V1, request });
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
}
