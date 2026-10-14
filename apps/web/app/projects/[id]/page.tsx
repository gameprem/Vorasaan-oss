import {
  type AttachmentView,
  type BriefDiff,
  type BriefProposalView,
  type BriefVersionView,
  DEFAULT_FEATURE_SUGGESTIONS,
  type DecisionStatsView,
  type DesignTemplatesView,
  type EffectiveFeatureGuidelinesView,
  type FeatureSuggestionStatus,
  type FeatureSuggestionView,
  type GrillingView,
  MAX_FEATURE_SUGGESTIONS,
  type OrgFeatureGuidelinesView,
  type ProjectBriefView,
  type ProjectCoverageView,
  type ProjectFeatureGuidelinesView,
  type ProjectPlatformsView,
  type ProjectView,
  type SuggestionLevel,
  type TeamView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { Notice, relativeTime } from '@/components/bits';
import { BriefPanel } from '@/components/brief-panel';
import { CoverageMatrix } from '@/components/coverage-matrix';
import { DecisionSpeedPanel } from '@/components/decision-speed-panel';
import { DeleteByName } from '@/components/delete-by-name';
import { DesignTemplatesEditor } from '@/components/design-templates-editor';
import { DraftedWith } from '@/components/drafted-with';
import { GrillingSection } from '@/components/grilling-section';
import { ProjectGuidelinesEditor } from '@/components/guidelines-editor';
import { EffectiveGuidelinesList, Tag } from '@/components/guidelines-list';
import { PlatformsList, ProjectPlatformsEditor } from '@/components/platforms-editor';
import { RedraftsSection } from '@/components/redrafts-section';
import { RevertButton } from '@/components/revert-button';
import { VersionDiff } from '@/components/spec-diff';
import { field, secondaryButton } from '@/components/ui';
import { Select } from '@/components/ui/select';
import { ApiError, api, currentUser } from '@/lib/api';
import { isId } from '@/lib/ids';
import {
  acceptSuggestion,
  dismissSuggestion,
  generateSuggestions,
  revertBrief,
} from '@/lib/project-actions';

export const metadata = { title: 'Project' };

const TABS = [
  { id: 'brief', label: 'Brief' },
  { id: 'history', label: 'History' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'grilling', label: 'Grilling' },
  { id: 'guidelines', label: 'Guidelines' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'platforms', label: 'Platforms' },
  { id: 'coverage', label: 'Coverage' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const SOURCE_TEXT: Record<BriefVersionView['source'], string> = {
  MANUAL: 'Edited by hand',
  GRILLING: 'From a Grilling',
  REVERT: 'Reverted',
  CONVERSATION: 'Drafted in a Conversation',
};

const LEVEL_TEXT: Record<SuggestionLevel, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
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

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    approved?: string;
    diff?: string;
    missing?: string;
    reason?: string;
  }>;
}) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const { tab: rawTab, approved, diff: rawDiff, missing, reason } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : 'brief';

  let project: ProjectView | undefined;
  let brief: ProjectBriefView;
  try {
    let projects: ProjectView[];
    [projects, brief] = await Promise.all([
      api<ProjectView[]>('/projects'),
      api<ProjectBriefView>(`/projects/${id}/brief`),
    ]);
    project = projects.find((p) => p.id === id);
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this Project.'}
      </Notice>
    );
  }
  if (!project) notFound();
  const [me, stats] = await Promise.all([
    currentUser(),
    load(() => api<DecisionStatsView>(`/projects/${id}/decision-stats`)),
  ]);
  const canEdit = brief.canEdit;

  return (
    <article>
      {approved && (
        <div className="mb-6">
          <Notice>
            Project Brief v{approved} approved. Every AI workflow in the Project reads it.
          </Notice>
        </div>
      )}

      <p className="text-sm text-fg-soft">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>
      </p>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
        {me?.isAdmin && (
          <DeleteByName
            kind="Project"
            id={id}
            name={project.name}
            then="/projects"
            consequences="Its Teams and their Features, the Project Brief, Grillings, Feature Suggestions, Platforms, Conversations and Attachments are deleted with it. Receipts of the AI’s work in it are kept."
          />
        )}
      </div>
      <p className="mt-2 text-sm text-fg-soft">
        {project.teams.length === 0
          ? 'No Teams yet.'
          : project.teams.map((t, i) => (
              <span key={t.id}>
                {i > 0 && ', '}
                <Link href={`/teams/${t.id}`} className="underline-offset-2 hover:underline">
                  {t.name}
                </Link>
              </span>
            ))}
        {project.jiraKey && ` · Jira ${project.jiraKey}`}
      </p>

      {stats.data ? (
        <DecisionSpeedPanel stats={stats.data} />
      ) : (
        <div className="mt-6">
          <Notice tone="error">{stats.error}</Notice>
        </div>
      )}

      <nav aria-label="Project sections" className="mt-6 flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/projects/${id}?tab=${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium ${
              tab === t.id
                ? 'bg-ink-wash font-semibold text-ink'
                : 'bg-surface text-fg hover:bg-surface-hi'
            }`}
          >
            {t.label}
            {t.id === 'history' && brief.version > 0 ? ` (${brief.version})` : ''}
          </Link>
        ))}
      </nav>

      <div className="mt-8">
        {tab === 'brief' && <BriefTab projectId={id} brief={brief} />}
        {tab === 'history' && <HistoryTab projectId={id} brief={brief} rawDiff={rawDiff} />}
        {tab === 'attachments' && <AttachmentsTab projectId={id} canEdit={canEdit} />}
        {tab === 'grilling' && (
          <GrillingTab projectId={id} meId={me?.id ?? null} canEdit={canEdit} />
        )}
        {tab === 'guidelines' && <GuidelinesTab projectId={id} canEdit={canEdit} />}
        {tab === 'suggestions' && (
          <SuggestionsTab projectId={id} project={project} canEdit={canEdit} />
        )}
        {tab === 'platforms' && <PlatformsTab projectId={id} />}
        {tab === 'coverage' && (
          <CoverageTab projectId={id} missingOnly={missing === '1'} reason={reason} />
        )}
      </div>
    </article>
  );
}

async function BriefTab({ projectId, brief }: { projectId: string; brief: ProjectBriefView }) {
  const proposals = await load(() =>
    api<BriefProposalView[]>(`/projects/${projectId}/brief-proposals`),
  );
  const pending = proposals.data?.some((p) => p.status === 'PENDING');
  const current = brief.current;
  return (
    <div className="max-w-4xl">
      {pending && (
        <div className="mb-6">
          <Notice>
            A Brief Proposal is waiting for approval.{' '}
            <Link
              href={`/projects/${projectId}?tab=grilling#brief-proposal`}
              className="font-medium text-fg underline underline-offset-2"
            >
              Review it
            </Link>
          </Notice>
        </div>
      )}
      <BriefPanel
        projectId={projectId}
        markdown={brief.markdown}
        version={brief.version}
        meta={
          current
            ? `Project Brief v${current.version}, approved by ${current.approvedBy.name} ${relativeTime(current.createdAt)}`
            : null
        }
        canEdit={brief.canEdit}
      />
    </div>
  );
}

async function HistoryTab({
  projectId,
  brief,
  rawDiff,
}: {
  projectId: string;
  brief: ProjectBriefView;
  rawDiff?: string;
}) {
  const versions = await load(() =>
    api<BriefVersionView[]>(`/projects/${projectId}/brief-versions`),
  );
  if (!versions.data) return <Notice tone="error">{versions.error}</Notice>;
  if (versions.data.length === 0) {
    return (
      <p className="text-fg-soft">
        No Brief Versions yet. Each approved edit, Grilling or revert of the Project Brief becomes a
        numbered version here.
      </p>
    );
  }
  // `?diff=N` compares vN with the version before it (v1 with an empty Brief).
  const diffTo = Number(rawDiff);
  const showDiff = Number.isSafeInteger(diffTo) && versions.data.some((v) => v.version === diffTo);
  const diff = showDiff
    ? await load(() =>
        api<BriefDiff>(`/projects/${projectId}/brief-diff?from=${diffTo - 1}&to=${diffTo}`),
      )
    : null;
  const latest = brief.version;

  return (
    <ol className="max-w-4xl rows">
      {versions.data.map((v) => {
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
                      ? `/projects/${projectId}?tab=history`
                      : `/projects/${projectId}?tab=history&diff=${v.version}`
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
                {brief.canEdit && v.version !== latest && (
                  <RevertButton
                    action={revertBrief.bind(null, projectId, v.version, latest)}
                    version={v.version}
                    baseVersion={latest}
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
  );
}

async function AttachmentsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const attachments = await load(() => api<AttachmentView[]>(`/projects/${projectId}/attachments`));
  if (!attachments.data) return <Notice tone="error">{attachments.error}</Notice>;
  return (
    <AttachmentsPanel
      owner={{ kind: 'projects', id: projectId }}
      attachments={attachments.data}
      canEdit={canEdit}
      emptyHint="The Project’s POs and Admins add them."
    />
  );
}

async function GrillingTab({
  projectId,
  meId,
  canEdit,
}: {
  projectId: string;
  meId: string | null;
  canEdit: boolean;
}) {
  const [grillings, proposals] = await Promise.all([
    load(() => api<GrillingView[]>(`/projects/${projectId}/grillings`)),
    load(() => api<BriefProposalView[]>(`/projects/${projectId}/brief-proposals`)),
  ]);
  if (!grillings.data || !proposals.data) {
    return <Notice tone="error">{grillings.error ?? proposals.error}</Notice>;
  }
  return (
    <GrillingSection
      projectId={projectId}
      grillings={grillings.data}
      proposals={proposals.data}
      meId={meId}
      canEdit={canEdit}
    />
  );
}

async function GuidelinesTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [effective, overrides, orgDefault] = await Promise.all([
    load(() =>
      api<EffectiveFeatureGuidelinesView>(`/projects/${projectId}/feature-guidelines/effective`),
    ),
    canEdit
      ? load(() => api<ProjectFeatureGuidelinesView>(`/projects/${projectId}/feature-guidelines`))
      : null,
    // The Organization default, readable by every member: the editor shows each inherited
    // criterion's text, including ones this Project hides.
    canEdit ? load(() => api<OrgFeatureGuidelinesView>('/settings/feature-guidelines')) : null,
  ]);
  if (!effective.data) return <Notice tone="error">{effective.error}</Notice>;

  return (
    <div className="max-w-4xl">
      <p className="text-fg-soft">
        What a new Feature in this Project must serve or respect. The AI checks Feature Suggestions
        and new Features against them. They come from the Organization’s Feature Guidelines (
        <Link href="/settings/feature-guidelines" className="underline underline-offset-2">
          Settings → Feature Guidelines
        </Link>
        ), adjusted for this Project.
      </p>

      <h2 className="mt-8 text-lg font-semibold">In effect</h2>
      {effective.data.criteria.length === 0 ? (
        <p className="mt-2 text-fg-soft">No Feature Guidelines apply to this Project yet.</p>
      ) : (
        <div className="mt-3">
          <EffectiveGuidelinesList criteria={effective.data.criteria} />
        </div>
      )}

      {canEdit && overrides && (
        <section aria-labelledby="overrides-heading" className="mt-12">
          <h2 id="overrides-heading" className="text-lg font-semibold">
            Adjust for this Project
          </h2>
          <p className="mt-1 mb-6 text-sm text-fg-soft">
            Edit or hide a criterion inherited from the Organization, or add one only this Project
            has. Saving replaces all of this Project’s adjustments at once.
          </p>
          {overrides.data && orgDefault?.data ? (
            <ProjectGuidelinesEditor
              projectId={projectId}
              overrides={overrides.data.overrides}
              orgDefault={orgDefault.data.criteria}
            />
          ) : (
            <Notice tone="error">{overrides.error ?? orgDefault?.error}</Notice>
          )}
        </section>
      )}
    </div>
  );
}

async function PlatformsTab({ projectId }: { projectId: string }) {
  const [platforms, templates] = await Promise.all([
    load(() => api<ProjectPlatformsView>(`/projects/${projectId}/platforms`)),
    load(() => api<DesignTemplatesView>(`/projects/${projectId}/design-templates`)),
  ]);
  if (!platforms.data) return <Notice tone="error">{platforms.error}</Notice>;
  return (
    <div className="max-w-3xl">
      <p className="text-fg-soft">
        The parts of the product this Project’s Features ship on. A Feature targets some of them,
        its Spec gets a section for each, and Coverage checks each one with the checks it switches
        on. The list started as a copy of the Organization’s Platform template (
        <Link href="/settings/platforms" className="underline underline-offset-2">
          Settings → Platforms
        </Link>
        ).
      </p>
      <div className="mt-8">
        {platforms.data.canEdit ? (
          <ProjectPlatformsEditor projectId={projectId} platforms={platforms.data.platforms} />
        ) : (
          <>
            <p className="mb-4 text-sm text-fg-soft">
              The Project’s POs and Admins change this list.
            </p>
            <PlatformsList platforms={platforms.data.platforms} />
          </>
        )}
      </div>
      <section aria-labelledby="design-templates" className="mt-12">
        <h2 id="design-templates" className="text-xl font-semibold">
          Design Doc templates
        </h2>
        <p className="mt-1 text-fg-soft">
          What each target Platform’s Design Doc, and QA’s, starts from. The AI fills each{' '}
          <code>##</code> section from the approved Spec and the Decisions, and lists what they
          leave open. A Platform names its template above.
        </p>
        {templates.data ? (
          <DesignTemplatesEditor
            projectId={projectId}
            templates={templates.data.templates}
            canEdit={templates.data.canEdit}
          />
        ) : (
          <Notice tone="error">{templates.error}</Notice>
        )}
      </section>
    </div>
  );
}

async function CoverageTab({
  projectId,
  missingOnly,
  reason,
}: {
  projectId: string;
  missingOnly: boolean;
  reason?: string;
}) {
  const coverage = await load(() => api<ProjectCoverageView>(`/projects/${projectId}/coverage`));
  if (!coverage.data) return <Notice tone="error">{coverage.error}</Notice>;
  return (
    <CoverageMatrix
      coverage={coverage.data}
      initialMissingOnly={missingOnly}
      initialReason={reason}
    />
  );
}

const SUGGESTION_GROUPS: { status: FeatureSuggestionStatus; heading: string }[] = [
  { status: 'PENDING', heading: 'Waiting for a decision' },
  { status: 'ACCEPTED', heading: 'Accepted' },
  { status: 'DISMISSED', heading: 'Dismissed' },
];

async function SuggestionsTab({
  projectId,
  project,
  canEdit,
}: {
  projectId: string;
  project: ProjectView;
  canEdit: boolean;
}) {
  const [suggestions, effective, teams] = await Promise.all([
    load(() => api<FeatureSuggestionView[]>(`/projects/${projectId}/feature-suggestions`)),
    load(() =>
      api<EffectiveFeatureGuidelinesView>(`/projects/${projectId}/feature-guidelines/effective`),
    ),
    // The Teams the viewer may accept into: Admins any, POs their own (the API checks it).
    canEdit
      ? load(async () => {
          const all = await Promise.all(project.teams.map((t) => api<TeamView>(`/teams/${t.id}`)));
          return all.filter((t) => t.canManage);
        })
      : null,
  ]);
  if (!suggestions.data) return <Notice tone="error">{suggestions.error}</Notice>;
  const titles = new Map((effective.data?.criteria ?? []).map((c) => [c.id, c.title]));
  const acceptTeams = teams?.data ?? [];

  return (
    <div className="max-w-4xl">
      <p className="text-fg-soft">
        Features the AI proposes from the Project Brief, the Feature Guidelines and the Decision
        Log. Accepting one creates the Feature in a Team with a first Spec to approve; dismissing
        one needs a reason, which the AI takes into account next time.
      </p>

      {canEdit && (
        <div className="mt-6 rounded-card bg-rail p-5">
          <ActionForm
            action={generateSuggestions.bind(null, projectId)}
            submitLabel="Generate Feature Suggestions"
            pendingLabel="Generating… (this can take a minute)"
          >
            <label className="w-40">
              <span className="text-sm">How many</span>
              <input
                name="count"
                type="number"
                min={1}
                max={MAX_FEATURE_SUGGESTIONS}
                defaultValue={DEFAULT_FEATURE_SUGGESTIONS}
                required
                className={field}
              />
            </label>
          </ActionForm>
        </div>
      )}

      {suggestions.data.length === 0 ? (
        <p className="mt-8 text-fg-soft">
          No Feature Suggestions yet.
          {canEdit
            ? ' Generate some above; a Project Brief makes them better.'
            : ' The Project’s POs or an Admin generate them.'}
        </p>
      ) : (
        SUGGESTION_GROUPS.map(({ status, heading }) => {
          const group = suggestions.data?.filter((s) => s.status === status) ?? [];
          if (group.length === 0) return null;
          return (
            <section key={status} aria-labelledby={`suggestions-${status}`} className="mt-10">
              <h2 id={`suggestions-${status}`} className="text-lg font-semibold">
                {heading} ({group.length})
              </h2>
              <ul className="mt-3 space-y-4">
                {group.map((s) => (
                  <li key={s.id} className="rounded-card bg-rail p-5">
                    <h3 className="font-semibold">{s.title}</h3>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Tag>Effort: {LEVEL_TEXT[s.effort]}</Tag>
                      <Tag>Risk: {LEVEL_TEXT[s.risk]}</Tag>
                    </div>
                    <p className="mt-3">{s.rationale}</p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Business value: </span>
                      {s.businessValue}
                    </p>
                    {s.servesGuidelineIds.length > 0 && (
                      <p className="mt-2 text-sm text-fg-soft">
                        Serves:{' '}
                        {s.servesGuidelineIds
                          .map((g) => titles.get(g) ?? 'a criterion no longer in effect')
                          .join('; ')}
                      </p>
                    )}
                    <p className="mt-2 text-sm text-fg-soft">
                      Generated by {s.generatedBy.name} {relativeTime(s.createdAt)}
                    </p>

                    {s.status === 'ACCEPTED' && (
                      <p className="mt-3 text-sm">
                        Accepted by {s.decidedBy?.name ?? 'someone'}
                        {s.decidedAt && ` ${relativeTime(s.decidedAt)}`}.{' '}
                        {s.featureId ? (
                          <Link
                            href={`/features/${s.featureId}`}
                            className="font-medium text-jade underline-offset-2 hover:underline"
                          >
                            Open the Feature
                          </Link>
                        ) : (
                          'Its Feature was deleted since.'
                        )}
                      </p>
                    )}
                    {s.status === 'DISMISSED' && (
                      <p className="mt-3 text-sm">
                        Dismissed by {s.decidedBy?.name ?? 'someone'}
                        {s.decidedAt && ` ${relativeTime(s.decidedAt)}`}: {s.dismissReason}
                      </p>
                    )}

                    {s.status === 'PENDING' && canEdit && (
                      <div className="mt-4">
                        <RedraftsSection kind="FEATURE_SUGGESTION" id={s.id} />
                      </div>
                    )}
                    {s.status === 'PENDING' && canEdit && (
                      <div className="mt-5 grid gap-6 pt-4 md:grid-cols-2">
                        {acceptTeams.length > 0 ? (
                          <ActionForm
                            action={acceptSuggestion.bind(null, projectId, s.id)}
                            submitLabel="Accept"
                            pendingLabel="Accepting… (the AI drafts the first Spec)"
                          >
                            <Select
                              label="Team"
                              name="teamId"
                              className="min-w-48 flex-1"
                              options={acceptTeams.map((t) => ({ id: t.id, label: t.name }))}
                              defaultValue={acceptTeams[0]?.id}
                              isRequired
                            />
                          </ActionForm>
                        ) : (
                          <p className="text-sm text-fg-soft">
                            {teams?.error ??
                              'To accept, you need a Team in this Project where you are PO (or be an Admin).'}
                          </p>
                        )}
                        <ActionForm
                          action={dismissSuggestion.bind(null, projectId, s.id)}
                          submitLabel="Dismiss"
                          pendingLabel="Dismissing…"
                        >
                          <label className="min-w-48 flex-1">
                            <span className="text-sm">Why dismiss it?</span>
                            <input
                              name="reason"
                              required
                              maxLength={1000}
                              placeholder="Out of scope this year"
                              className={field}
                            />
                          </label>
                        </ActionForm>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
