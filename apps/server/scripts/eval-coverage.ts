// Manual eval (ticket 0051): Coverage in the AI's inputs, against the real model, so a human
// can judge each output: does a Spec draft fill the missing Platform sections from what it
// was given, or ask an open question instead of inventing requirements; does Grilling ask
// about the Platforms no Feature covers; are a Platform's drafted acceptance criteria
// testable, traced to the Spec and the Decisions, and is the rest of the Spec unchanged.
// Not part of `bun run test`.
//   bun run eval:coverage
//   bun run eval:coverage -- --english-first   (ticket 0068's comparison)
// Each case's own checks (sections present, criteria present, injection ignored) and the
// Thai cases' language checks (ticket 0068) are scored automatically.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import { COVERAGE_EVAL_CASES as cases } from '../src/evals/cases/coverage.ts';
import { scoreOutput } from '../src/evals/eval-case.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
if (
  config.draftAcceptanceCriteriaModel.startsWith('anthropic/') &&
  !process.env.ANTHROPIC_API_KEY
) {
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
    console.log(`━━ ${c.name}  (${seconds}s)\n${JSON.stringify(result, null, 2)}`);
    const { score, checks } = scoreOutput({ expect: c.expect }, result);
    for (const check of checks) {
      console.log(
        `   ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? `: ${check.detail}` : ''}`,
      );
    }
    console.log(`   score ${(score * 100).toFixed(0)}%\n`);
    if (c.lang) checkLanguage(c.name, result, c.lang);
  } catch (error) {
    console.log(`━━ ${c.name}: FAILED ${(error as Error).message}\n`);
  }
}

printLanguageSummary('eval:coverage');
