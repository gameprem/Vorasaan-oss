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
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import { CHOICES_SAMPLES as samples } from '../src/evals/cases/choices.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

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
