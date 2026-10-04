// Shared by the manual eval scripts (ticket 0068): the language comparison mode, and
// automatic checks for the Thai and mixed Thai-English cases, so two runs can be
// compared by their totals as well as read.
//
//   bun run eval:<set>                    answer directly in the reply language (the product)
//   bun run eval:<set> -- --english-first work the task out in English, then answer
//
// The checks themselves live in src/evals/language-check.ts, where the in-app evals
// (ticket 0071) score with them too. The totals print at the end, with each failure.
import type { LanguageStrategy } from '../src/ai/language.ts';
import { type LanguageExpectation, languageProblems } from '../src/evals/language-check.ts';

export type { LanguageExpectation } from '../src/evals/language-check.ts';
export { thaiShare } from '../src/evals/language-check.ts';

/** The strategy this run uses: `--english-first` (or VORASAAN_EVAL_LANGUAGE=english-first). */
export const LANGUAGE_STRATEGY: LanguageStrategy =
  process.argv.includes('--english-first') || process.env.VORASAAN_EVAL_LANGUAGE === 'english-first'
    ? 'english-first'
    : 'direct';

export function languageBanner(): string {
  return LANGUAGE_STRATEGY === 'direct'
    ? 'Language: answer directly in the reply language (the product).'
    : 'Language: work the task out in English first, then answer in the reply language (comparison).';
}

type Result = { name: string; problems: string[] };
const results: Result[] = [];

/** Checks one output against its expectation and prints the verdict under it. */
export function checkLanguage(name: string, output: unknown, expect: LanguageExpectation): void {
  const { problems, share } = languageProblems(output, expect);
  const keep = expect.keep ?? [];
  results.push({ name, problems });
  console.log(
    problems.length
      ? `   ✗ language check (${expect.language}): ${problems.join('; ')}\n`
      : `   ✓ language check (${expect.language}, ${(share * 100).toFixed(0)}% Thai letters, ${keep.length} kept)\n`,
  );
}

/** The totals of this run's language checks, to compare `direct` with `english-first`. */
export function printLanguageSummary(set: string): void {
  const failed = results.filter((r) => r.problems.length);
  console.log(
    `══ ${set}, ${LANGUAGE_STRATEGY}: ${results.length - failed.length}/${results.length} language checks passed`,
  );
  for (const f of failed) console.log(`   ✗ ${f.name}: ${f.problems.join('; ')}`);
  console.log();
}
