// Manual eval (ticket 0072): runs the Learning Loop's own prompts against the real model, so a
// human can judge them: does the feedback analysis name the patterns that recur (and only
// those, citing the right cases), in English, Thai and mixed Thai-English, without following
// an instruction hidden in the feedback? Does a proposed Prompt Version change only what the
// patterns call for and keep every placeholder? Does a Redraft do what the Admin asked, and
// nothing a feedback injection asked? Not part of `bun run test`.
//   bun run eval:prompt-proposals
//   bun run eval:prompt-proposals -- --english-first   (ticket 0068's comparison)
// Every case is also scored on its checks, as the in-app evals score it.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import { PROMPT_PROPOSAL_EVAL_CASES as cases } from '../src/evals/cases/prompt-proposals.ts';
import { scoreOutput } from '../src/evals/eval-case.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
if (config.analyzeFeedbackModel.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
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
    const { score, checks } = scoreOutput(c, result);
    const failed = checks.filter((check) => !check.passed);
    console.log(`━━ ${c.name}  (${seconds}s, ${Math.round(score * 100)}%)`);
    for (const check of failed) console.log(`   ✗ ${check.name}: ${check.detail ?? ''}`);
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    if (c.lang) checkLanguage(c.name, result, c.lang);
  } catch (error) {
    console.log(`━━ ${c.name}: FAILED ${(error as Error).message}\n`);
  }
}

printLanguageSummary('eval:prompt-proposals');
