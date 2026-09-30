import type {
  EffectiveGuidelineCriterion,
  GuidelineCriterionKind,
  GuidelineCriterionOrigin,
} from '@vorasaan/shared';
import type { ReactNode } from 'react';

export const GuidelineKindLabel: Record<GuidelineCriterionKind, string> = {
  KPI: 'KPI',
  CONSTRAINT: 'Constraint',
  REQUIRED_SECTION: 'Required section',
};

const ORIGIN_LABEL: Record<GuidelineCriterionOrigin, string> = {
  ORGANIZATION: 'Organization',
  PROJECT: 'This Project',
  PROJECT_EDIT: 'Organization, edited here',
};

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-full border border-rule px-2 py-0.5 text-xs text-ink-soft">
      {children}
    </span>
  );
}

/** The effective Feature Guidelines of a Project, in order, with where each criterion comes from. */
export function EffectiveGuidelinesList({
  criteria,
  showOrigin = true,
}: {
  criteria: EffectiveGuidelineCriterion[];
  showOrigin?: boolean;
}) {
  return (
    <ol className="divide-y divide-rule border-y border-rule">
      {criteria.map((c) => (
        <li key={c.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.title}</span>
            <Tag>{GuidelineKindLabel[c.kind]}</Tag>
            <Tag>{c.required ? 'Required' : 'Optional'}</Tag>
            {showOrigin && (
              <span className="text-xs text-ink-soft">From: {ORIGIN_LABEL[c.origin]}</span>
            )}
          </div>
          {c.description && <p className="mt-1 text-sm text-ink-soft">{c.description}</p>}
        </li>
      ))}
    </ol>
  );
}
