// Manual eval (ticket 0065): runs Request changes cases against the real model, one per kind
// of proposal and in English and Thai, so a human can judge each Redraft: did it change what
// was asked and nothing else, keep the language, find the stated preferences, and ignore
// feedback that tries to do anything but change the proposal. Not part of `bun run test`.
//   bun run eval:redrafts
//   bun run eval:redrafts -- --english-first   (ticket 0068's comparison)
// The Thai and mixed Thai-English cases (0068) are checked automatically: in the reply
// language, with ids, numbers and quoted words kept exactly (see eval-language.ts).
// More cases: export real feedback with GET /redrafts/eval-cases (Admins) and add them here.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import { REDRAFT_EVAL_CASES as cases } from '../src/evals/cases/redrafts.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
if (config.redraftSpecProposalModel.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(async (task) => config[`${task}Model`], LANGUAGE_STRATEGY);
console.log(`${languageBanner()}\n`);

for (const c of cases) {
  const started = performance.now();
  try {
    const result = await c.run(ai, { language: c.lang?.language });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`━━ ${c.name}  (${seconds}s)\n${JSON.stringify(result, null, 2)}\n`);
    if (c.lang) checkLanguage(c.name, result, c.lang);
  } catch (error) {
    console.log(`━━ ${c.name}: FAILED ${(error as Error).message}\n`);
  }
}

printLanguageSummary('eval:redrafts');
