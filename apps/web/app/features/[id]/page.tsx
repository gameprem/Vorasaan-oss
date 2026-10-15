import type {
  AttachmentView,
  DecisionGraphView,
  DecisionLogEntry,
  FeatureCoverageView,
  FeatureDesignDocsView,
  FeatureView,
  ProjectPlatformsView,
  RoleOwnerView,
  SpecDiff,
  SpecTemplateView,
  SpecVersionView,
  TeamView,
} from '@vorasaan/shared';
import { DECISION_SOURCE_LABEL } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { BlockedBadge, KindBadge, Notice, relativeTime } from '@/components/bits';
import { CoverageChips } from '@/components/coverage-chips';
import { DecisionGraph } from '@/components/decision-graph';
import { DeleteByName } from '@/components/delete-by-name';
import { DesignDocLanes } from '@/components/design-doc-lanes';
import {
  DesignDocLink,
  DesignDocStateBadge,
  DraftDesignDocButton,
  RefreshWhileDrafting,
} from '@/components/design-docs';
import { DraftedWith } from '@/components/drafted-with';
import { FeaturePlatformsEditor } from '@/components/feature-platforms-editor';
import { RevertButton } from '@/components/revert-button';
import { RoleOwnersEditor } from '@/components/role-owners-editor';
import { VersionDiff } from '@/components/spec-diff';
import { SpecPanel } from '@/components/spec-panel';
import { ROLE_LABEL, secondaryButton } from '@/components/ui';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError, api, currentUser } from '@/lib/api';
import { approversText, designDocLine } from '@/lib/design-docs';
import { revertSpec } from '@/lib/feature-actions';
import { isId } from '@/lib/ids';

export const metadata = { title: 'Feature' };

const TABS = [
  { id: 'spec', label: 'Spec' },
  { id: 'design-docs', label: 'Design Docs' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'team', label: 'Role Owners' },
  { id: 'history', label: 'Version history' },
  { id: 'decisions', label: 'Decision Log' },
  { id: 'graph', label: 'Decision Graph' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const SOURCE_TEXT: Record<SpecVersionView['source'], string> = {
  MANUAL: 'Edited by hand',
  AI_SUMMARY: 'Drafted from Attachments',
  DECISION: 'From a Decision',
  REVERT: 'Reverted',
  CONVERSATION: 'Drafted in a Conversation',
  ACCEPTANCE_CRITERIA: "Drafted a Platform's acceptance criteria",
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
  // Coverage per target Platform (ADR 0009): the header's chips. Without it, plain names.
  const [me, coverage] = await Promise.all([
    currentUser(),
    feature.platforms.length > 0
      ? load(() => api<FeatureCoverageView>(`/features/${id}/coverage`))
      : null,
  ]);
  const canEditSpec = Boolean(me?.isAdmin || feature.myRoles.includes('PO'));
  const canEditAttachments = Boolean(me?.isAdmin || feature.myRoles.length > 0);

  const team = tab === 'team' ? await api<TeamView>(`/teams/${feature.teamId}`) : null;
  // Who writes the Spec also picks its target Platforms; a first Spec starts from a template
  // with a section for each of them (ADR 0009).
  const [projectPlatforms, specTemplate] =
    tab === 'spec' && canEditSpec
      ? await Promise.all([
          load(() => api<ProjectPlatformsView>(`/projects/${feature.projectId}/platforms`)),
          latest ? null : load(() => api<SpecTemplateView>(`/features/${id}/spec-template`)),
        ])
      : [null, null];
  const attachments =
    tab === 'attachments'
      ? await load(() => api<AttachmentView[]>(`/features/${id}/attachments`))
      : null;
  const designDocs =
    tab === 'design-docs'
      ? await load(() => api<FeatureDesignDocsView>(`/features/${id}/design-docs`))
      : null;
  const graph =
    tab === 'graph'
      ? await load(() => api<DecisionGraphView>(`/features/${id}/decision-graph`))
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

      <p className="text-sm text-fg-soft">
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
          {coverage?.data ? (
            <CoverageChips
              featureId={id}
              platforms={coverage.data.platforms}
              canDraft={canEditSpec}
            />
          ) : (
            feature.platforms.length > 0 && (
              <ul aria-label="Target Platforms" className="mt-2 flex flex-wrap gap-2">
                {feature.platforms.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-full bg-surface px-3 py-0.5 text-sm text-fg-soft"
                  >
                    {p.name}
                  </li>
                ))}
              </ul>
            )
          )}
          {feature.jiraIssueKey && (
            <p className="mt-2 text-sm text-fg-soft">
              Jira Epic{' '}
              {feature.jiraIssueUrl ? (
                <a
                  href={feature.jiraIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-fg underline underline-offset-2"
                >
                  {feature.jiraIssueKey}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className="font-medium text-fg">{feature.jiraIssueKey}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {feature.myRoles.length > 0 && (
            <Link href={`/features/${id}/raise`} className={secondaryButton}>
              Raise a Decision Request
            </Link>
          )}
          {/* Who writes the Spec may delete the Feature: its POs and Admins (ticket 0049). */}
          {canEditSpec && (
            <DeleteByName
              kind="Feature"
              id={id}
              name={feature.title}
              then={`/projects/${feature.projectId}`}
              consequences="Its Spec and Spec Versions, Decision Requests and Decisions, Design Docs, Conversations and Attachments are deleted with it. Receipts of the AI’s work on it are kept."
            />
          )}
        </div>
      </div>

      <nav aria-label="Feature sections" className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/features/${id}?tab=${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium ${
              tab === t.id
                ? 'bg-ink-wash font-semibold text-ink'
                : 'bg-surface text-fg hover:bg-surface-hi'
            }`}
          >
            {t.label}
            {t.id === 'decisions' && log.length > 0 ? ` (${log.length})` : ''}
            {t.id === 'history' && versions.length > 0 ? ` (${versions.length})` : ''}
          </Link>
        ))}
      </nav>

      <div className="mt-8">
        {tab === 'spec' && projectPlatforms?.data && projectPlatforms.data.platforms.length > 0 && (
          <FeaturePlatformsEditor
            featureId={id}
            platforms={projectPlatforms.data.platforms}
            targets={feature.platforms.map((p) => p.id)}
          />
        )}
        {tab === 'spec' && (
          <SpecPanel
            template={specTemplate?.data?.markdown}
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

        {tab === 'design-docs' &&
          designDocs &&
          (designDocs.data ? (
            <section aria-labelledby="design-docs-heading" className="max-w-4xl">
              <RefreshWhileDrafting
                active={designDocs.data.docs.some((d) => d.state === 'DRAFTING')}
              />
              <h2 id="design-docs-heading" className="sr-only">
                Design Docs
              </h2>
              <p className="mb-6 text-fg-soft">
                How each target Platform will build what the Spec says, and QA's test plan. The AI
                drafts each one from the approved Spec once its Platform is covered; a Tech Lead or
                a Role Owner of the Platform approves it.
              </p>
              <ul className="rows">
                {designDocs.data.docs.map((d) => (
                  <li key={d.key} className="py-5" data-testid={`design-doc-${d.name}`}>
                    <div className="flex flex-wrap items-center gap-3">
                      <DesignDocLink featureId={id} doc={d}>
                        {d.name} Design Doc
                      </DesignDocLink>
                      <DesignDocStateBadge state={d.state} />
                    </div>
                    <p className="mt-2">{designDocLine(d)}</p>
                    <p className="mt-1 text-sm text-fg-soft">
                      Approved by a {approversText(d)}.
                      {d.questions.length > 0 &&
                        ` ${d.questions.length} question${d.questions.length === 1 ? '' : 's'} raised.`}
                    </p>
                    {d.canApprove &&
                      (d.state === 'READY' || (d.state === 'STALE' && !d.proposal)) && (
                        <div className="mt-3">
                          <DraftDesignDocButton featureId={id} doc={d} />
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <Notice tone="error">{designDocs.error}</Notice>
          ))}

        {tab === 'attachments' &&
          attachments &&
          (attachments.data ? (
            <AttachmentsPanel
              owner={{ kind: 'features', id }}
              attachments={attachments.data}
              canEdit={canEditAttachments}
              canDraft={canEditSpec}
              emptyHint="Role Owners of this Feature add them."
            />
          ) : (
            <Notice tone="error">{attachments.error}</Notice>
          ))}

        {tab === 'team' &&
          team &&
          (team.canManage ? (
            <div className="max-w-3xl">
              <p className="mb-6 text-fg-soft">
                Decision Requests on this Feature go to its Role Owners. Choose who owns each role.
              </p>
              <RoleOwnersEditor featureId={id} team={team} owners={owners} />
            </div>
          ) : owners.length === 0 ? (
            <p className="text-fg-soft">No Role Owners yet. The Team's PO or an Admin sets them.</p>
          ) : (
            <ul className="max-w-3xl rows">
              {owners.map((o) => (
                <li key={`${o.userId}:${o.role}`} className="flex justify-between py-3">
                  <span className="font-medium">{o.name}</span>
                  <span className="text-fg-soft">{ROLE_LABEL[o.role]}</span>
                </li>
              ))}
            </ul>
          ))}

        {tab === 'history' &&
          (versions.length === 0 ? (
            <p className="text-fg-soft">No Spec Versions yet.</p>
          ) : (
            <ol className="max-w-4xl rows">
              {versions.map((v) => {
                const open = showDiff && diffTo === v.version;
                return (
                  <li key={v.id} className="py-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
                      <span className="w-12 shrink-0 font-semibold">v{v.version}</span>
                      <span className="flex-1">
                        <span className="block">{v.summary ?? SOURCE_TEXT[v.source]}</span>
                        <span className="block text-sm text-fg-soft">
                          {SOURCE_TEXT[v.source]}
                          {v.revertedFrom !== null && ` from v${v.revertedFrom}`}, approved by{' '}
                          {v.approvedBy.name} {relativeTime(v.createdAt)}
                        </span>
                        <DraftedWith model={v.draftedWith} />
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
                            action={revertSpec.bind(null, id, v.version, latest.version)}
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
            <p className="text-fg-soft">
              No Decisions yet. When someone decides a Blocker or Question on this Feature, it is
              recorded here with the Spec version it produced.
            </p>
          ) : (
            <ol className="max-w-3xl rows">
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
                  {entry.rationale && <p className="mt-1 text-fg-soft">{entry.rationale}</p>}
                  <DraftedWith model={entry.choicesDraftedWith} what="Choices" />
                  <p className="mt-2 text-sm text-fg-soft">
                    Decided by {entry.decidedBy.name}
                    {entry.onBehalfOf && ` on behalf of ${entry.onBehalfOf.name}`}
                    {entry.source !== 'WEB' && ` in ${DECISION_SOURCE_LABEL[entry.source]}`}{' '}
                    {relativeTime(entry.createdAt)}.{' '}
                    {entry.specVersion ? (
                      <Link
                        href={`/features/${id}?tab=history&diff=${entry.specVersion}`}
                        className="text-jade underline underline-offset-2"
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

        {tab === 'graph' &&
          graph &&
          (!graph.data ? (
            <Notice tone="error">{graph.error}</Notice>
          ) : graph.data.branches.length === 0 ? (
            <>
              <EmptyState
                title="No Decision Requests yet"
                action={
                  feature.myRoles.length > 0 ? (
                    <Link href={`/features/${id}/raise`} className={secondaryButton}>
                      Raise a Decision Request
                    </Link>
                  ) : undefined
                }
              >
                When someone raises a Blocker or a Question on this Feature, it branches off the
                Spec here and merges back at the Spec Version it produces.
              </EmptyState>
              <DesignDocLanes graph={graph.data} />
            </>
          ) : (
            <>
              <DecisionGraph graph={graph.data} />
              <DesignDocLanes graph={graph.data} />
            </>
          ))}
      </div>
    </article>
  );
}
