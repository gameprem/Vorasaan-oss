import type { ChoiceDraft, ProposalKind, RedraftPointer } from '@vorasaan/shared';

// Request changes and Redrafts (ticket 0065): where each kind of proposal's Redrafts live
// in the API, and the same-origin route the browser calls them through
// (app/api/redrafts/[kind]/[id]).

/** The browser's name for each kind of proposal, as the route's `[kind]` segment. */
export const REDRAFT_SLUG = {
  CHOICES: 'choices',
  SPEC_PROPOSAL: 'spec-proposals',
  BRIEF_PROPOSAL: 'brief-proposals',
  FEATURE_SUGGESTION: 'feature-suggestions',
} as const satisfies Record<ProposalKind, string>;
export type RedraftSlug = (typeof REDRAFT_SLUG)[ProposalKind];

/** The API path a proposal's Redrafts hang off: `…/request-changes`, `…/redrafts`. */
export function redraftApiBase(slug: RedraftSlug, id: string): string {
  return slug === 'choices' ? `/decision-requests/${id}/choices` : `/${slug}/${id}`;
}

export function isRedraftSlug(value: string): value is RedraftSlug {
  return (Object.values(REDRAFT_SLUG) as string[]).includes(value);
}

/** The browser-side route for a proposal's Redrafts. */
export const redraftRoute = (kind: ProposalKind, id: string) =>
  `/api/redrafts/${REDRAFT_SLUG[kind]}/${id}`;

/** A part of the proposal the feedback can point at. */
export type PointerOption = { label: string; pointer: RedraftPointer };

/** One option per Choice. */
export function choicePointers(choices: Pick<ChoiceDraft, 'label' | 'title'>[]): PointerOption[] {
  return choices.map((c) => ({
    label: `Choice ${c.label}: ${c.title}`,
    pointer: { kind: 'CHOICE', label: c.label },
  }));
}

/** One option per section (heading) of a Markdown proposal. */
export function sectionPointers(markdown: string): PointerOption[] {
  const out: PointerOption[] = [];
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1]?.trim();
    if (heading && !out.some((o) => o.label === `Section: ${heading}`)) {
      out.push({ label: `Section: ${heading}`, pointer: { kind: 'SECTION', heading } });
    }
  }
  return out;
}
