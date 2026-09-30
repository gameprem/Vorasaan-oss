import type {
  AttachmentView,
  DecisionLogEntry,
  FeatureView,
  RoleOwnerView,
  SpecDiff,
  SpecVersionView,
  TeamView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { BlockedBadge, KindBadge, Notice, relativeTime } from '@/components/bits';
import { RevertButton } from '@/components/revert-button';
import { RoleOwnersEditor } from '@/components/role-owners-editor';
import { VersionDiff } from '@/components/spec-diff';
import { SpecPanel } from '@/components/spec-panel';
import { ROLE_LABEL, secondaryButton } from '@/components/ui';
import { ApiError, api, currentUser } from '@/lib/api';
import { isId } from '@/lib/ids';

export const metadata = { title: 'Feature' };

const TABS = [
  { id: 'spec', label: 'Spec' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'team', label: 'Role Owners' },
  { id: 'history', label: 'Version history' },
  { id: 'decisions', label: 'Decision Log' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const SOURCE_TEXT: Record<SpecVersionView['source'], string> = {
  MANUAL: 'Edited by hand',
  AI_SUMMARY: 'Drafted from Attachments',
  DECISION: 'From a Decision',
  REVERT: 'Reverted',
};

/** Loads what only one tab needs; an error there is shown in the tab, not as the whole page. */
async function load<T>(run: () => Promise<T>): Promise<{ data?: T; error?: string }> {
  try {
    return { data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    return { error: error instanceof ApiError ? error.message : 'Could not load this section.' };
  }
}

export default async function FeaturePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; approved?: string; diff?: string }>;
}) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const { tab: rawTab, approved, diff: rawDiff } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : 'spec';

  let feature: FeatureView;
  let versions: SpecVersionView[];
  let log: DecisionLogEntry[];
  let owners: RoleOwnerView[];
  try {
    [feature, versions, log, owners] = await Promise.all([
      api<FeatureView>(`/features/${id}`),
      api<SpecVersionView[]>(`/features/${id}/spec-versions`),
      api<DecisionLogEntry[]>(`/features/${id}/decision-log`),
      api<RoleOwnerView[]>(`/features/${id}/role-owners`),
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
  const me = await currentUser();
  const canEditSpec = Boolean(me?.isAdmin || feature.myRoles.includes('PO'));
  const canEditAttachments = Boolean(me?.isAdmin || feature.myRoles.length > 0);

  const team = tab === 'team' ? await api<TeamView>(`/teams/${feature.teamId}`) : null;
  const attachments =
    tab === 'attachments'
      ? await load(() => api<AttachmentView[]>(`/features/${id}/attachments`))
      : null;
  // `?diff=N` compares vN with the version before it (v1 with an empty Spec).
  const diffTo = Number(rawDiff);
  const showDiff =
    tab === 'history' && Number.isSafeInteger(diffTo) && versions.some((v) => v.version === diffTo);
  const diff = showDiff
    ? await load(() => api<SpecDiff>(`/features/${id}/spec-diff?from=${diffTo - 1}&to=${diffTo}`))
    : null;

  return (
    <article>
      {approved && (
        <div className="mb-6">
          <Notice>Spec v{approved} approved. The team now builds from this version.</Notice>
        </div>
      )}

      <p className="text-sm text-ink-soft">
        {feature.projectName},{' '}
        <Link href={`/teams/${feature.teamId}`} className="hover:underline">
          {feature.teamName} team
        </Link>
      </p>
      <div className="mt-1 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{feature.title}</h1>
            <BlockedBadge openBlockers={feature.openBlockers} />
          </div>
          {feature.jiraIssueKey && (
            <p className="mt-2 text-sm text-ink-soft">
              Jira Epic{' '}
              {feature.jiraIssueUrl ? (
                <a
                  href={feature.jiraIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-ink underline underline-offset-2"
                >
                  {feature.jiraIssueKey}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className="font-medium text-ink">{feature.jiraIssueKey}</span>
              )}
            </p>
          )}
        </div>
        {feature.myRoles.length > 0 && (
          <Link href={`/features/${id}/raise`} className={secondaryButton}>
            Raise a Decision Request
          </Link>
        )}
      </div>

      <nav
        aria-label="Feature sections"
        className="flex gap-6 overflow-x-auto border-b border-rule"
      >
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/features/${id}?tab=${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 pb-2 text-sm ${
              tab === t.id
                ? 'border-ink font-medium text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t.label}
            {t.id === 'decisions' && log.length > 0 ? ` (${log.length})` : ''}
            {t.id === 'history' && versions.length > 0 ? ` (${versions.length})` : ''}
          </Link>
        ))}
      </nav>

      <div className="mt-8">
        {tab === 'spec' && (
          <SpecPanel
            featureId={id}
            markdown={latest?.markdown ?? null}
            version={latest?.version ?? 0}
            meta={
              latest
                ? `Spec v${latest.version}, approved by ${latest.approvedBy.name} ${relativeTime(latest.createdAt)}`
                : null
            }
            canEdit={canEditSpec}
          />
        )}

        {tab === 'attachments' &&
          attachments &&
          (attachments.data ? (
            <AttachmentsPanel
              featureId={id}
              attachments={attachments.data}
              canEdit={canEditAttachments}
              canDraft={canEditSpec}
            />
          ) : (
            <Notice tone="error">{attachments.error}</Notice>
          ))}

        {tab === 'team' &&
          team &&
          (team.canManage ? (
            <div className="max-w-3xl">
              <p className="mb-6 text-ink-soft">
                Decision Requests on this Feature go to its Role Owners. Choose who owns each role.
              </p>
              <RoleOwnersEditor featureId={id} team={team} owners={owners} />
            </div>
          ) : owners.length === 0 ? (
            <p className="text-ink-soft">
              No Role Owners yet. The Team's PO or an Admin sets them.
            </p>
          ) : (
            <ul className="max-w-3xl divide-y divide-rule border-y border-rule">
              {owners.map((o) => (
                <li key={`${o.userId}:${o.role}`} className="flex justify-between py-3">
                  <span className="font-medium">{o.name}</span>
                  <span className="text-ink-soft">{ROLE_LABEL[o.role]}</span>
                </li>
              ))}
            </ul>
          ))}

        {tab === 'history' &&
          (versions.length === 0 ? (
            <p className="text-ink-soft">No Spec Versions yet.</p>
          ) : (
            <ol className="max-w-4xl divide-y divide-rule border-y border-rule">
              {versions.map((v) => {
                const open = showDiff && diffTo === v.version;
                return (
                  <li key={v.id} className="py-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
                      <span className="w-12 shrink-0 font-semibold">v{v.version}</span>
                      <span className="flex-1">
                        <span className="block">{v.summary ?? SOURCE_TEXT[v.source]}</span>
                        <span className="block text-sm text-ink-soft">
                          {SOURCE_TEXT[v.source]}
                          {v.revertedFrom !== null && ` from v${v.revertedFrom}`}, approved by{' '}
                          {v.approvedBy.name} {relativeTime(v.createdAt)}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-start gap-2">
                        <Link
                          href={
                            open
                              ? `/features/${id}?tab=history`
                              : `/features/${id}?tab=history&diff=${v.version}`
                          }
                          aria-expanded={open}
                          className={`${secondaryButton} text-sm`}
                          scroll={false}
                        >
                          {open
                            ? 'Hide changes'
                            : v.version === 1
                              ? 'Show v1'
                              : `Compare with v${v.version - 1}`}
                        </Link>
                        {canEditSpec && latest && v.version !== latest.version && (
                          <RevertButton
                            featureId={id}
                            version={v.version}
                            baseVersion={latest.version}
                          />
                        )}
                      </span>
                    </div>
                    {open && diff && (
                      <div className="mt-4">
                        {diff.data ? (
                          <VersionDiff diff={diff.data} />
                        ) : (
                          <Notice tone="error">{diff.error}</Notice>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          ))}

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
                    Decided by {entry.decidedBy.name}
                    {entry.onBehalfOf && ` on behalf of ${entry.onBehalfOf.name}`}{' '}
                    {relativeTime(entry.createdAt)}.{' '}
                    {entry.specVersion ? (
                      <Link
                        href={`/features/${id}?tab=history&diff=${entry.specVersion}`}
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
