'use client';

import type {
  PromptEvalRunSummary,
  PromptProposalView,
  ProposalRedraftsView,
} from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { approvePromptVersion, declinePromptVersion } from '@/lib/prompt-actions';
import {
  Badge,
  Comparison,
  Patterns,
  POLL_MS,
  percent,
  Section,
  Status,
  setLabel,
  useAction,
  VersionRow,
  versionLabel,
} from './prompt-versions';
import { ProposalRedrafts } from './redrafts';
import { VersionDiff } from './spec-diff';
import { field } from './ui';
import { Button } from './ui/button';

// A Prompt Version the AI proposed from a prompt's feedback (ADR 0015, ticket 0072), as an
// Admin decides it: the patterns it addresses and why, the diff from the version it was
// evaluated against, the scores before and after with sample outputs side by side, and
// Approve, Decline (with a reason) or Request changes (a Redraft, whose evals run again).
// Nothing changes until an Admin approves it, whatever its scores.

export function PromptProposal({
  name,
  view,
  redrafts,
}: {
  name: string;
  view: PromptProposalView;
  redrafts: ProposalRedraftsView | null;
}) {
  const router = useRouter();
  const { version } = view;
  const evaluating = [view.before, view.after].some((r) => r?.status === 'RUNNING');
  useEffect(() => {
    if (!evaluating) return;
    const poll = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(poll);
  }, [evaluating, router]);

  return (
    <div>
      <h2 className="mt-3 text-[26px] font-semibold tracking-tight">
        {versionLabel(version.number)} of {name}
      </h2>
      <div className="mt-2" data-testid="proposal-version">
        <VersionRow v={version} />
      </div>
      {view.analysis && (
        <Section title="What people asked for">
          <p className="mt-1 text-sm text-fg-soft">
            The patterns the AI found in {view.analysis.outcomes} outcomes of this prompt.
          </p>
          <Patterns patterns={view.analysis.patterns} />
        </Section>
      )}
      <Section title="Changes">
        <div className="mt-3">
          <VersionDiff
            diff={view.diff}
            caption={`${versionLabel(view.diff.from)} → ${versionLabel(view.diff.to)}`}
          />
        </div>
      </Section>
      <Scores view={view} />
      {version.status === 'PROPOSED' ? (
        <Decide name={name} view={view} redrafts={redrafts} evaluating={evaluating} />
      ) : (
        <Section title="Decided">
          <p className="mt-2">
            {version.status === 'APPROVED'
              ? `Approved${version.approvedBy ? ` by ${version.approvedBy.name}` : ''}${version.active ? ': it is active.' : '.'}`
              : `Declined${version.declinedBy ? ` by ${version.declinedBy.name}` : ''}${version.declineReason ? `: “${version.declineReason}”` : '.'}`}
          </p>
          {redrafts && (
            <ProposalRedrafts kind="PROMPT_VERSION" proposalId={version.id} redrafts={redrafts} />
          )}
        </Section>
      )}
    </div>
  );
}

function RunScore({ label, run }: { label: string; run: PromptEvalRunSummary | null }) {
  return (
    <div className="rounded-card bg-rail p-3" data-testid={`score-${label.toLowerCase()}`}>
      <p className="text-xs text-fg-soft">
        {label}: {run ? `${versionLabel(run.number)} on ${run.model.displayName}` : 'no run'}
      </p>
      <p className="text-2xl font-semibold">
        {!run ? '–' : run.status === 'RUNNING' ? 'Running…' : percent(run.score)}
      </p>
      {run && run.status !== 'RUNNING' && (
        <p className="text-xs text-fg-soft">
          {run.setScores.map((s) => `${setLabel(s.set)} ${percent(s.score)}`).join(', ')}
        </p>
      )}
      {run?.status === 'RUNNING' && (
        <p className="text-xs text-fg-soft">
          {run.done}/{run.total} cases
        </p>
      )}
      {run?.status === 'FAILED' && <p className="text-xs text-lacquer">{run.error}</p>}
    </div>
  );
}

function Scores({ view }: { view: PromptProposalView }) {
  return (
    <Section title="Evals">
      <p className="mt-1 text-sm text-fg-soft">
        Run on it and on the version it would replace, on the same model and cases, as soon as it
        was proposed or redrafted.
      </p>
      {view.evalsNote ? (
        <p className="mt-3">{view.evalsNote}</p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <RunScore label="Before" run={view.before} />
          <RunScore label="After" run={view.after} />
        </div>
      )}
      {view.comparison && <Comparison comparison={view.comparison} />}
    </Section>
  );
}

function Decide({
  name,
  view,
  redrafts,
  evaluating,
}: {
  name: string;
  view: PromptProposalView;
  redrafts: ProposalRedraftsView | null;
  evaluating: boolean;
}) {
  const { version } = view;
  const action = useAction();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const writing = redrafts?.writing ?? false;
  const label = versionLabel(version.number);
  return (
    <Section title="Decide">
      <p className="mt-1 text-sm text-fg-soft">
        Approving makes it the active version of this prompt for the whole Organization. You can
        roll back at any time.
        {evaluating && ' Its evals are still running.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          isDisabled={action.pending || writing}
          onPress={() =>
            action.run(
              () => approvePromptVersion(name, version.number),
              `${label} is approved and active.`,
            )
          }
        >
          Approve {label}
        </Button>
        <Button isDisabled={action.pending} onPress={() => setDeclining(!declining)}>
          Decline…
        </Button>
        <Badge tone="amber">Waiting for approval</Badge>
      </div>
      {declining && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () => declinePromptVersion(name, version.number, reason),
              `${label} is declined.`,
              () => setDeclining(false),
            );
          }}
        >
          <div className="grow">
            <label htmlFor={reasonId} className="text-sm">
              Why (the AI learns from it)
            </label>
            <input
              id={reasonId}
              className={field}
              value={reason}
              required
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button type="submit" variant="danger" isDisabled={action.pending || !reason.trim()}>
            Decline {label}
          </Button>
        </form>
      )}
      <Status message={action.message} />
      {redrafts && (
        <div className="mt-4">
          <ProposalRedrafts kind="PROMPT_VERSION" proposalId={version.id} redrafts={redrafts} />
        </div>
      )}
    </Section>
  );
}
