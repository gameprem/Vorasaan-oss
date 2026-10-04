import type { PromptEvalCheck } from '@vorasaan/shared';
import type { SkillName } from '@vorasaan/skills';
import type { AiTask } from '../ai/ai.config.ts';
import type { AiCallOptions, AiPort } from '../ai/ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { type LanguageExpectation, languageProblems } from './language-check.ts';

// The checked-in eval cases (ticket 0071): the samples of `bun run eval:*`, shared with the
// manual scripts, each with checks the server can score on its own. A case scores the
// share of its checks passed: the answer was valid (the task's schema held), the language
// checks of ticket 0068 when it has an expectation (each kept text, and the language),
// and its own checks (an injection not followed, a follow-up asked or not...).

/** The checked-in eval sets, named after their `bun run eval:<set>` scripts. */
export const EVAL_SETS = [
  'choices',
  'spec-from-attachments',
  'grilling',
  'feature-suggestions',
  'conversation',
  'redrafts',
  'prompt-proposals',
] as const;
export type EvalSetName = (typeof EVAL_SETS)[number];

/** A check of a case's output: null when it holds, else why not. */
export type EvalExpectation = { name: string; check: (output: unknown) => string | null };

export type EvalCase = {
  /** `<set>/<slug>`: stable, so two runs compare case by case. */
  key: string;
  set: EvalSetName;
  name: string;
  task: AiTask;
  /** Asked for in the call, and checked when given. */
  lang?: LanguageExpectation;
  /** Runs the task; the options carry the model, the Prompt Version and the language. */
  run: (ai: AiPort, options: AiCallOptions) => Promise<unknown>;
  expect?: EvalExpectation[];
};

/** The prompt a case evaluates: the one its task renders. */
export function promptOfCase(c: EvalCase): SkillName {
  return TASK_SKILLS[c.task];
}

/** A case's output, scored by its checks: the share of them passed. */
export function scoreOutput(
  c: Pick<EvalCase, 'lang' | 'expect'>,
  output: unknown,
): { score: number; checks: PromptEvalCheck[] } {
  const checks: PromptEvalCheck[] = [{ name: 'A valid answer', passed: true, detail: null }];
  if (c.lang) {
    const { problems, share } = languageProblems(output, c.lang);
    for (const kept of c.lang.keep ?? []) {
      const lost = problems.find((p) => p.includes(JSON.stringify(kept)));
      checks.push({ name: `Keeps ${JSON.stringify(kept)}`, passed: !lost, detail: lost ?? null });
    }
    const wrong = problems.find((p) => p.startsWith('not '));
    checks.push({
      name: c.lang.language === 'th' ? 'Written in Thai' : 'Written in English',
      passed: !wrong,
      detail: wrong ?? `${(share * 100).toFixed(0)}% Thai letters`,
    });
  }
  for (const e of c.expect ?? []) {
    let problem: string | null;
    try {
      problem = e.check(output);
    } catch (error) {
      problem = (error as Error)?.message ?? String(error);
    }
    checks.push({ name: e.name, passed: problem === null, detail: problem });
  }
  return { score: checks.filter((ch) => ch.passed).length / checks.length, checks };
}

/** A failed call: one failed check, and no score. */
export function failedCheck(error: string): { score: number; checks: PromptEvalCheck[] } {
  return { score: 0, checks: [{ name: 'A valid answer', passed: false, detail: error }] };
}

/** Every string in an output, joined: what the injection checks read. */
export function allText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(allText).join('\n');
  if (output && typeof output === 'object') return Object.values(output).map(allText).join('\n');
  return '';
}

/** An expectation that none of `phrases` appears in the output (an injection not followed). */
export function never(name: string, ...phrases: string[]): EvalExpectation {
  return {
    name,
    check: (output) => {
      const text = allText(output).toLowerCase();
      const found = phrases.find((p) => text.includes(p.toLowerCase()));
      return found ? `contains ${JSON.stringify(found)}` : null;
    },
  };
}

/** An expectation that every one of `phrases` appears in the output. */
export function mentions(name: string, ...phrases: string[]): EvalExpectation {
  return {
    name,
    check: (output) => {
      const text = allText(output);
      const missing = phrases.filter((p) => !text.includes(p));
      return missing.length ? `missing ${missing.map((p) => JSON.stringify(p)).join(', ')}` : null;
    },
  };
}

/** A key from a set and a case's name. */
export function caseKey(set: EvalSetName, name: string): string {
  return `${set}/${name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9฀-๿]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)}`;
}
