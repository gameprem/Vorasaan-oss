import type { CoverageGap } from './coverage.ts';

// Plain values of coverage.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** Why a Platform is missing, in words: "No Spec section", "Nobody in the Team holds QA"... */
export function coverageGapText(gap: CoverageGap): string {
  switch (gap.check) {
    case 'SPEC_SECTION':
      return 'No Spec section';
    case 'SOMEONE_TO_ASK':
      return gap.roles.length
        ? `Nobody in the Team holds ${gap.roles.join(' or ')}`
        : 'Nobody to ask: the Platform names no Team Role';
    case 'NO_OPEN_BLOCKERS':
      return gap.blockers.length === 1
        ? `An open Blocker: ${gap.blockers[0]?.title}`
        : `${gap.blockers.length} open Blockers`;
    case 'QA_READY':
      if (gap.noCriteria && gap.noQa) {
        return 'Missing QA: no acceptance criteria or test cases, and nobody in the Team holds QA';
      }
      return gap.noCriteria
        ? 'Missing QA: no acceptance criteria or test cases'
        : 'Missing QA: nobody in the Team holds QA';
  }
}
