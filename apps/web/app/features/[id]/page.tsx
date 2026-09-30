import type { DecisionLogEntry, FeatureSummaryView, SpecVersionView } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { KindBadge, Notice, relativeTime } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Feature' };

const TABS = [
  { id: 'spec', label: 'Spec' },
  { id: 'history', label: 'Version history' },
  { id: 'decisions', label: 'Decision Log' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const SOURCE_TEXT: Record<SpecVersionView['source'], string> = {
  MANUAL: 'Edited by hand',
  AI_SUMMARY: 'Drafted from attachments',
  DECISION: 'From a Decision',
  REVERT: 'Reverted',
};

export default async function FeaturePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; approved?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab, approved } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : 'spec';

  let feature: FeatureSummaryView;
  let versions: SpecVersionView[];
  let log: DecisionLogEntry[];
  try {
    [feature, versions, log] = await Promise.all([
      api<FeatureSummaryView>(`/features/${id}`),
      api<SpecVersionView[]>(`/features/${id}/spec-versions`),
      api<DecisionLogEntry[]>(`/features/${id}/decision-log`),
    ]);
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this Feature.'}
      </Notice>
    );
  }
  const latest = versions[0];

  return (
    <article>
      {approved && (
        <div className="mb-6">
          <Notice>Spec v{approved} approved. The team now builds from this version.</Notice>
        </div>
      )}

      <p className="text-sm text-ink-soft">
        {feature.projectName}, {feature.teamName} team
      </p>
      <h1 className="mt-1 mb-6 text-3xl font-semibold tracking-tight">{feature.title}</h1>

      <nav aria-label="Feature sections" className="flex gap-6 border-b border-rule">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/features/${id}?tab=${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`-mb-px border-b-2 pb-2 text-sm ${
              tab === t.id
                ? 'border-ink font-medium text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t.label}
            {t.id === 'decisions' && log.length > 0 ? ` (${log.length})` : ''}
          </Link>
        ))}
      </nav>

      <div className="mt-8">
        {tab === 'spec' &&
          (latest ? (
            <>
              <p className="mb-6 text-sm text-ink-soft">
                Spec v{latest.version}, approved by {latest.approvedBy.name}{' '}
                {relativeTime(latest.createdAt)}
              </p>
              <div className="spec rounded-xl border border-rule bg-sheet p-6 sm:p-10">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{latest.markdown}</ReactMarkdown>
              </div>
            </>
          ) : (
            <p className="text-ink-soft">This Feature has no Spec yet.</p>
          ))}

        {tab === 'history' && (
          <ol className="max-w-3xl divide-y divide-rule border-y border-rule">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-col gap-1 py-4 sm:flex-row sm:gap-6">
                <span className="w-12 shrink-0 font-semibold">v{v.version}</span>
                <span className="flex-1">
                  <span className="block">{v.summary ?? SOURCE_TEXT[v.source]}</span>
                  <span className="block text-sm text-ink-soft">
                    {SOURCE_TEXT[v.source]}, approved by {v.approvedBy.name}
                  </span>
                </span>
                <span className="text-sm text-ink-soft">{relativeTime(v.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}

        {tab === 'decisions' &&
          (log.length === 0 ? (
            <p className="text-ink-soft">
              No Decisions yet. When someone decides a Blocker or Question on this Feature, it is
              recorded here with the Spec version it produced.
            </p>
          ) : (
            <ol className="max-w-3xl divide-y divide-rule border-y border-rule">
              {log.map((entry) => (
                <li key={entry.decisionId} className="py-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <KindBadge kind={entry.kind} />
                    <Link
                      href={`/requests/${entry.decisionRequestId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {entry.requestTitle}
                    </Link>
                  </div>
                  <p className="mt-2">
                    {entry.choice
                      ? `${entry.choice.label}. ${entry.choice.title}`
                      : entry.customAnswer}
                  </p>
                  {entry.rationale && <p className="mt-1 text-ink-soft">{entry.rationale}</p>}
                  <p className="mt-2 text-sm text-ink-soft">
                    Decided by {entry.decidedBy.name} {relativeTime(entry.createdAt)}.{' '}
                    {entry.specVersion ? (
                      <Link
                        href={`/features/${id}?tab=history`}
                        className="text-jade underline-offset-2 hover:underline"
                      >
                        Became Spec v{entry.specVersion}
                      </Link>
                    ) : (
                      'The Spec has not changed yet.'
                    )}
                  </p>
                </li>
              ))}
            </ol>
          ))}
      </div>
    </article>
  );
}
