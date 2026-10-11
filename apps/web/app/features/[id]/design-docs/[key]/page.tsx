import type {
  DesignDocDetailView,
  FeatureView,
  ProposalRedraftsView,
  SpecDiff as SpecDiffView,
} from '@vorasaan/shared';
import { DESIGN_TEMPLATE_LABEL, DesignDocKey } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Notice, relativeTime, statusText } from '@/components/bits';
import { Markdown } from '@/components/chat/markdown';
import {
  DesignDocStateBadge,
  DraftDesignDocButton,
  RefreshWhileDrafting,
  ReviewDesignDoc,
} from '@/components/design-docs';
import { DraftedWith } from '@/components/drafted-with';
import { RevertButton } from '@/components/revert-button';
import { SpecDiff, VersionDiff } from '@/components/spec-diff';
import { secondaryButton } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { revertDesignDoc } from '@/lib/design-doc-actions';
import { approversText, designDocLine } from '@/lib/design-docs';
import { isId } from '@/lib/ids';

export const metadata = { title: 'Design Doc' };

/**
 * One Design Doc of a Feature (ADR 0014, ticket 0069): where it stands, the draft waiting for
 * approval with its diff and Redrafts, the approved version, every version with its diff and
 * revert, and the questions its drafts raised.
 */
export default async function DesignDocPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; key: string }>;
  searchParams: Promise<{ diff?: string }>;
}) {
  const { id, key } = await params;
  if (!isId(id) || !DesignDocKey.safeParse(key).success) notFound();
  const diffTo = Number((await searchParams).diff);

  let feature: FeatureView;
  let detail: DesignDocDetailView;
  try {
    [feature, detail] = await Promise.all([
      api<FeatureView>(`/features/${id}`),
      api<DesignDocDetailView>(`/features/${id}/design-docs/${key}`),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this Design Doc.'}
      </Notice>
    );
  }
  const { doc, versions, proposal } = detail;
  const latest = versions[0];
  const showDiff = Number.isSafeInteger(diffTo) && versions.some((v) => v.version === diffTo);
  const [redrafts, diff] = await Promise.all([
    proposal
      ? api<ProposalRedraftsView>(`/design-doc-proposals/${proposal.id}/redrafts`).catch(() => null)
      : null,
    showDiff
      ? api<SpecDiffView>(
          `/features/${id}/design-docs/${key}/diff?from=${diffTo - 1}&to=${diffTo}`,
        ).catch(() => null)
      : null,
  ]);
  const canDraft =
    doc.canApprove && (doc.state === 'READY' || (doc.state === 'STALE' && !doc.proposal));

  return (
    <article className="max-w-4xl">
      <RefreshWhileDrafting active={doc.state === 'DRAFTING'} />
      <p className="text-sm text-fg-soft">
        <Link href={`/features/${id}?tab=design-docs`} className="hover:underline">
          {feature.title}
        </Link>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{doc.name} Design Doc</h1>
        <DesignDocStateBadge state={doc.state} />
      </div>
      <p className="mt-2">{designDocLine(doc)}</p>
      <p className="mt-1 text-sm text-fg-soft">
        From the {DESIGN_TEMPLATE_LABEL[doc.template]} template. A {approversText(doc)} approves it.
        It follows the Spec and never changes it.
      </p>
      {canDraft && (
        <div className="mt-4">
          <DraftDesignDocButton featureId={id} doc={doc} />
        </div>
      )}

      {proposal && (
        <section aria-labelledby="proposal-heading" className="mt-10">
          <h2 id="proposal-heading" className="text-xl font-semibold">
            {proposal.reason === 'FIRST_DRAFT'
              ? `Draft from Spec v${proposal.specVersion}`
              : `Update for Spec v${proposal.specVersion}`}
          </h2>
          <p className="mt-1 text-sm text-fg-soft">
            Drafted by the AI {relativeTime(proposal.createdAt)}
            {proposal.baseVersion ? `, changing v${proposal.baseVersion}` : ''}.
            {proposal.summary ? ` ${proposal.summary}` : ''}
          </p>
          <DraftedWith model={proposal.draftedWith} />
          <div className="mt-4">
            <SpecDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} />
          </div>
          {redrafts ? (
            <ReviewDesignDoc featureId={id} proposal={proposal} redrafts={redrafts} />
          ) : (
            <Notice tone="error">Could not load its Redrafts.</Notice>
          )}
        </section>
      )}

      {doc.questions.length > 0 && (
        <section aria-labelledby="questions-heading" className="mt-10">
          <h2 id="questions-heading" className="text-xl font-semibold">
            Questions raised
          </h2>
          <p className="mt-1 text-sm text-fg-soft">
            What the Spec and the Decisions leave open for this design, raised as Decision Requests
            on the Feature. A draft waits for its Raiser to send it.
          </p>
          <ul className="mt-3 rows">
            {doc.questions.map((q) => (
              <li key={q.id} className="flex flex-wrap justify-between gap-2 py-3">
                <Link
                  href={`/requests/${q.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {q.title}
                </Link>
                <span className="text-sm text-fg-soft">
                  {statusText(q.status)}, raised by {q.raiser.name}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {latest && (
        <section aria-labelledby="current-heading" className="mt-10">
          <h2 id="current-heading" className="text-xl font-semibold">
            Version {latest.version}
          </h2>
          <p className="mt-1 text-sm text-fg-soft">
            Follows Spec v{latest.specVersion}, approved by {latest.approvedBy.name}{' '}
            {relativeTime(latest.createdAt)}.
          </p>
          <Markdown className="mt-4 rounded-2xl bg-surface p-6">{latest.markdown}</Markdown>
        </section>
      )}

      {versions.length > 0 && (
        <section aria-labelledby="history-heading" className="mt-10">
          <h2 id="history-heading" className="text-xl font-semibold">
            Version history
          </h2>
          <ol className="mt-3 rows">
            {versions.map((v) => {
              const open = showDiff && diffTo === v.version;
              return (
                <li key={v.id} className="py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
                    <span className="w-12 shrink-0 font-semibold">v{v.version}</span>
                    <span className="flex-1">
                      <span className="block">
                        {v.summary ?? (v.source === 'REVERT' ? 'Reverted' : 'Drafted by the AI')}
                      </span>
                      <span className="block text-sm text-fg-soft">
                        Follows Spec v{v.specVersion}
                        {v.revertedFrom !== null && `, restored from v${v.revertedFrom}`}, approved
                        by {v.approvedBy.name} {relativeTime(v.createdAt)}
                      </span>
                      <DraftedWith model={v.draftedWith} />
                    </span>
                    <span className="flex flex-wrap items-start gap-2">
                      <Link
                        href={
                          open
                            ? `/features/${id}/design-docs/${key}`
                            : `/features/${id}/design-docs/${key}?diff=${v.version}`
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
                      {doc.canApprove && latest && v.version !== latest.version && (
                        <RevertButton
                          action={revertDesignDoc.bind(null, id, key, v.version, latest.version)}
                          version={v.version}
                          baseVersion={latest.version}
                        />
                      )}
                    </span>
                  </div>
                  {open && (
                    <div className="mt-4">
                      {diff ? (
                        <VersionDiff diff={diff} />
                      ) : (
                        <Notice tone="error">Could not load the changes.</Notice>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </article>
  );
}
