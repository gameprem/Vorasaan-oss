// Shared by the manual eval scripts (ticket 0068): the language comparison mode, and
// automatic checks for the Thai and mixed Thai-English cases, so two runs can be
// compared by their totals as well as read.
//
//   bun run eval:<set>                    answer directly in the reply language (the product)
//   bun run eval:<set> -- --english-first work the task out in English, then answer
//
// Each checked case asks for a reply language and lists what must survive exactly
// (Feature names, ids, numbers, people's quoted words). A case passes when every one of
// them is in the output verbatim and the output is in the reply language: for Thai, most
// of its letters (besides what is kept and Vorasaan's own terms) are Thai; for English,
// almost none are. The totals print at the end, with each failure.
import type { LanguageStrategy, ReplyLanguage } from '../src/ai/language.ts';

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

/** What a Thai or mixed case expects. */
export type LanguageExpectation = {
  /** The reply language asked for; the output must be in it. */
  language: ReplyLanguage;
  /** Text that must appear verbatim: names, ids, numbers, quoted words. */
  keep?: string[];
};

/** Vorasaan's terms (CONTEXT.md) and Team Roles, kept in English inside Thai text. */
const DOMAIN_TERMS = [
  'Organization',
  'Project Brief',
  'Brief Proposal',
  'Brief',
  'Project',
  'Team Role',
  'Team',
  'Feature Guidelines',
  'Feature Suggestion',
  'Feature',
  'Spec Version',
  'Spec Proposal',
  'Spec',
  'Grilling Conversation',
  'Grilling',
  'Decision Request',
  'Decision Log',
  'Decision',
  'Blocker',
  'Question',
  'Raiser',
  'Decider',
  'Choice',
  'Conversation',
  'Action Card',
  'Attachment',
  'Redraft',
  'PO',
  'Designer',
  'Tech Lead',
  'TECH_LEAD',
  'Backend',
  'Frontend',
  'Mobile',
  'QA',
];

/** Fields whose values the prompts ask for in English or as codes, whatever the language. */
const CODE_FIELDS = new Set([
  'preferences',
  'suggestedRole',
  'label',
  'effort',
  'risk',
  'verdict',
  'guideline',
  'servesGuidelines',
]);

/** Every human-readable string in an output (a string, or the string leaves of an object). */
function textsOf(output: unknown, key?: string): string[] {
  if (key && CODE_FIELDS.has(key)) return [];
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) return output.flatMap((v) => textsOf(v));
  if (output && typeof output === 'object') {
    return Object.entries(output).flatMap(([k, v]) => textsOf(v, k));
  }
  return [];
}

/** Thai letters as a share of Thai and Latin letters, after removing what is kept as written. */
export function thaiShare(text: string, kept: string[] = []): number {
  let rest = text.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const k of [...kept, ...DOMAIN_TERMS].sort((a, b) => b.length - a.length)) {
    rest = rest.split(k).join(' ');
  }
  // Ids and codes such as PAY-142, DR-12, GET /v2/payments.
  rest = rest.replace(/\b[A-Z][A-Z0-9_]*-\d+\b/g, ' ').replace(/\/[\w/{}.-]+/g, ' ');
  const thai = rest.match(/[฀-๿]/g)?.length ?? 0;
  const latin = rest.match(/[A-Za-z]/g)?.length ?? 0;
  return thai + latin === 0 ? 0 : thai / (thai + latin);
}

type Result = { name: string; problems: string[] };
const results: Result[] = [];

/** Checks one output against its expectation and prints the verdict under it. */
export function checkLanguage(name: string, output: unknown, expect: LanguageExpectation): void {
  const text = textsOf(output).join('\n');
  const keep = expect.keep ?? [];
  const problems: string[] = [];
  for (const k of keep) {
    if (!text.includes(k)) problems.push(`lost or changed: ${JSON.stringify(k)}`);
  }
  const share = thaiShare(text, keep);
  if (expect.language === 'th' && share < 0.6) {
    problems.push(`not Thai enough: ${(share * 100).toFixed(0)}% Thai letters`);
  }
  if (expect.language === 'en' && share > 0.05) {
    problems.push(`not English: ${(share * 100).toFixed(0)}% Thai letters`);
  }
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
