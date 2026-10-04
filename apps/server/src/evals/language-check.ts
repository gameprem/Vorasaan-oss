// The automatic language checks of the eval sets (ticket 0068), shared by the manual eval
// scripts (scripts/eval-*.ts) and the in-app evals (ticket 0071). A checked case asks for a
// reply language and lists what must survive exactly (Feature names, ids, numbers, people's
// quoted words). It passes when every one of them is in the output verbatim and the output
// is in the reply language: for Thai, most of its letters (besides what is kept and
// Vorasaan's own terms) are Thai; for English, almost none are.
import type { ReplyLanguage } from '../ai/language.ts';

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
export function textsOf(output: unknown, key?: string): string[] {
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

/** The least share of Thai letters a Thai output has, and the most an English one has. */
export const THAI_AT_LEAST = 0.6;
export const ENGLISH_THAI_AT_MOST = 0.05;

/** One language check's verdict: what was lost or changed, and the share of Thai letters. */
export function languageProblems(
  output: unknown,
  expect: LanguageExpectation,
): { problems: string[]; share: number } {
  const text = textsOf(output).join('\n');
  const keep = expect.keep ?? [];
  const problems: string[] = [];
  for (const k of keep) {
    if (!text.includes(k)) problems.push(`lost or changed: ${JSON.stringify(k)}`);
  }
  const share = thaiShare(text, keep);
  if (expect.language === 'th' && share < THAI_AT_LEAST) {
    problems.push(`not Thai enough: ${(share * 100).toFixed(0)}% Thai letters`);
  }
  if (expect.language === 'en' && share > ENGLISH_THAI_AT_MOST) {
    problems.push(`not English: ${(share * 100).toFixed(0)}% Thai letters`);
  }
  return { problems, share };
}
