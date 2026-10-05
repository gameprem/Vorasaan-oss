import type { SkillName } from '@vorasaan/skills';
import { CHOICES_EVAL_CASES } from './cases/choices.ts';
import { CONVERSATION_EVAL_CASES } from './cases/conversation.ts';
import { COVERAGE_EVAL_CASES } from './cases/coverage.ts';
import { FEATURE_SUGGESTION_EVAL_CASES } from './cases/feature-suggestions.ts';
import { GRILLING_EVAL_CASES } from './cases/grilling.ts';
import { PROMPT_PROPOSAL_EVAL_CASES } from './cases/prompt-proposals.ts';
import { REDRAFT_EVAL_CASES } from './cases/redrafts.ts';
import { SPEC_FROM_ATTACHMENTS_EVAL_CASES } from './cases/spec-from-attachments.ts';
import { type EvalCase, promptOfCase } from './eval-case.ts';

/**
 * Every checked-in eval case (ticket 0071), from the samples of `bun run eval:*`. The
 * retrieval set (`eval:retrieval`) needs a seeded database and measures retrieval, not a
 * prompt, so it stays a script.
 */
export const EVAL_CASES: EvalCase[] = [
  ...CHOICES_EVAL_CASES,
  ...SPEC_FROM_ATTACHMENTS_EVAL_CASES,
  ...GRILLING_EVAL_CASES,
  ...FEATURE_SUGGESTION_EVAL_CASES,
  ...CONVERSATION_EVAL_CASES,
  ...REDRAFT_EVAL_CASES,
  ...PROMPT_PROPOSAL_EVAL_CASES,
  ...COVERAGE_EVAL_CASES,
];

/** The checked-in cases that evaluate one prompt. */
export function casesForPrompt(name: SkillName): EvalCase[] {
  return EVAL_CASES.filter((c) => promptOfCase(c) === name);
}
