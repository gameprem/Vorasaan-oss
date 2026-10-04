'use client';

import type {
  ApprovedModelSettingsView,
  PromptDetailView,
  PromptDiff,
  PromptEvalCaseView,
  PromptEvalComparison,
  PromptEvalRunSummary,
  PromptEvalRunView,
  PromptEvalSource,
  PromptSummaryView,
  PromptVersionView,
} from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useState, useTransition } from 'react';
import {
  type ActionResult,
  approvePromptVersion,
  comparePromptRuns,
  declinePromptVersion,
  promptDiff,
  promptEvalRun,
  proposePromptVersion,
  rollbackPrompt,
  startPromptEval,
} from '@/lib/prompt-actions';
import { SettingsLink } from './settings-dialog';
import { VersionDiff } from './spec-diff';
import { field } from './ui';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Select } from './ui/select';

// Settings → AI → Prompts (ADR 0015, ticket 0071): each built-in prompt with its active
// version, the Organization's Prompt Versions (written by hand, approved by an Admin, rolled
// back), the diff between two, and eval runs with their comparison.

/** How a version is named: "Default" for the built-in prompt (0), else "v3". */
export const versionLabel = (number: number) => (number === 0 ? 'Default' : `v${number}`);

const percent = (score: number | null) => (score === null ? '–' : `${Math.round(score * 100)}%`);
const numberFormat = new Intl.NumberFormat('en');
const tokens = (n: number | null) => (n === null ? '–' : numberFormat.format(n));
const when = (iso: string) =>
  new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });

/** How often a page with an eval run in progress refreshes. */
const POLL_MS = 1500;

const SET_LABEL: Record<string, string> = {
  choices: 'Choices',
  'spec-from-attachments': 'Spec from Attachments',
  grilling: 'Grilling',
  'feature-suggestions': 'Feature Suggestions',
  conversation: 'Conversation',
  redrafts: 'Redrafts',
  replay: 'Replay of approved Receipts',
};
const setLabel = (set: string) => SET_LABEL[set] ?? set;

/** Runs a server action and keeps its error (or a short confirmation) for display. */
function useAction() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const run = (action: () => Promise<ActionResult>, done?: string, onOk?: () => void) =>
    start(async () => {
      setMessage(undefined);
      const result = await action();
      if (result.error) setMessage({ ok: false, text: result.error });
      else {
        setMessage(done ? { ok: true, text: done } : undefined);
        onOk?.();
      }
    });
  return { pending, message, run };
}

function Status({ message }: { message?: { ok: boolean; text: string } }) {
  if (!message) return null;
  return (
    <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-jade' : 'text-lacquer'}>
      {message.text}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10">
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'jade' | 'amber' | 'soft' | 'lacquer';
  children: ReactNode;
}) {
  const tones = {
    jade: 'bg-jade-wash text-jade',
    amber: 'bg-rail text-fg',
    soft: 'bg-rail text-fg-soft',
    lacquer: 'bg-lacquer-wash text-lacquer',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

// ─── The list ───────────────────────────────────────────────────────────────

export function PromptList({ prompts }: { prompts: PromptSummaryView[] }) {
  return (
    <table className="mt-6 w-full text-left text-sm">
      <thead className="text-fg-soft">
        <tr>
          <th className="py-2 font-medium">Prompt</th>
          <th className="py-2 font-medium">Active</th>
          <th className="py-2 font-medium">Versions</th>
          <th className="py-2 font-medium">Eval cases</th>
        </tr>
      </thead>
      <tbody>
        {prompts.map((p) => (
          <tr key={p.name} className="border-t border-line">
            <td className="py-2">
              <SettingsLink
                href={`/settings/ai/prompts/${p.name}`}
                className="font-medium text-fg underline-offset-2 hover:underline"
              >
                {p.name}
              </SettingsLink>
              <span className="block text-xs text-fg-soft">{p.tasks.join(', ')}</span>
            </td>
            <td className="py-2" data-testid={`active-${p.name}`}>
              {versionLabel(p.active.number)}
            </td>
            <td className="py-2">
              {p.versions}
              {p.proposed > 0 && (
                <span className="ml-2">
                  <Badge tone="amber">{p.proposed} waiting</Badge>
                </span>
              )}
            </td>
            <td className="py-2">
              {p.evalCases}
              {p.replayable && <span className="text-fg-soft"> + replay</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── One prompt ─────────────────────────────────────────────────────────────

export function PromptDetail({
  prompt,
  models,
}: {
  prompt: PromptDetailView;
  models: ApprovedModelSettingsView[];
}) {
  const router = useRouter();
  const running = prompt.runs.some((r) => r.status === 'RUNNING');
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(poll);
  }, [running, router]);

  return (
    <div>
      <h2 className="mt-3 text-[26px] font-semibold tracking-tight">{prompt.name}</h2>
      <p className="mt-1 text-sm text-fg-soft">Used for: {prompt.tasks.join(', ')}</p>
      <p className="mt-3" data-testid="active-version">
        Active: <strong>{versionLabel(prompt.active.number)}</strong>{' '}
        <code className="text-xs text-fg-soft">{prompt.active.version}</code>
        {prompt.active.since && (
          <span className="text-sm text-fg-soft">
            {' '}
            since {when(prompt.active.since)}
            {prompt.active.by && `, by ${prompt.active.by.name}`}
          </span>
        )}
      </p>
      <Versions prompt={prompt} />
      <CompareVersions prompt={prompt} />
      <WriteVersion prompt={prompt} />
      <Evals prompt={prompt} models={models} />
      <History prompt={prompt} />
    </div>
  );
}

function Versions({ prompt }: { prompt: PromptDetailView }) {
  const action = useAction();
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const defaultActive = prompt.active.number === 0;

  return (
    <Section title="Versions">
      <ul className="mt-3 divide-y divide-line">
        {prompt.versions.map((v) => (
          <li key={v.id} className="py-3" aria-label={versionLabel(v.number)}>
            <VersionRow v={v} />
            <div className="mt-2 flex flex-wrap gap-2">
              {v.status === 'PROPOSED' && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    isDisabled={action.pending}
                    onPress={() =>
                      action.run(
                        () => approvePromptVersion(prompt.name, v.number),
                        `${versionLabel(v.number)} is approved and active.`,
                      )
                    }
                  >
                    Approve {versionLabel(v.number)}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={action.pending}
                    onPress={() => setDeclining(declining === v.number ? null : v.number)}
                  >
                    Decline…
                  </Button>
                </>
              )}
              {v.status === 'APPROVED' && !v.active && (
                <Button
                  size="sm"
                  isDisabled={action.pending}
                  onPress={() =>
                    action.run(
                      () => rollbackPrompt(prompt.name, v.number),
                      `${versionLabel(v.number)} is active again.`,
                    )
                  }
                >
                  Roll back to {versionLabel(v.number)}
                </Button>
              )}
              <TemplateToggle template={v.template} label={versionLabel(v.number)} />
            </div>
            {declining === v.number && (
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  action.run(
                    () => declinePromptVersion(prompt.name, v.number, reason),
                    `${versionLabel(v.number)} is declined.`,
                    () => {
                      setDeclining(null);
                      setReason('');
                    },
                  );
                }}
              >
                <label className="grow text-sm">
                  Why (optional)
                  <input
                    className={field}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <Button type="submit" variant="danger" size="sm" isDisabled={action.pending}>
                  Decline {versionLabel(v.number)}
                </Button>
              </form>
            )}
          </li>
        ))}
        <li className="py-3" aria-label="Default">
          <div className="flex flex-wrap items-center gap-2">
            <strong>Default</strong>
            {defaultActive && <Badge tone="jade">Active</Badge>}
            <span className="text-sm text-fg-soft">The built-in prompt, from packages/skills.</span>
          </div>
          <code className="text-xs text-fg-soft">{prompt.default.version}</code>
          <div className="mt-2 flex flex-wrap gap-2">
            {!defaultActive && (
              <Button
                size="sm"
                isDisabled={action.pending}
                onPress={() =>
                  action.run(() => rollbackPrompt(prompt.name, 0), 'The default is active again.')
                }
              >
                Roll back to the default
              </Button>
            )}
            <TemplateToggle template={prompt.default.template} label="Default" />
          </div>
        </li>
      </ul>
      <Status message={action.message} />
    </Section>
  );
}

function VersionRow({ v }: { v: PromptVersionView }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{versionLabel(v.number)}</strong>
        {v.active && <Badge tone="jade">Active</Badge>}
        {v.status === 'PROPOSED' && <Badge tone="amber">Waiting for approval</Badge>}
        {v.status === 'APPROVED' && !v.active && <Badge tone="soft">Approved</Badge>}
        {v.status === 'DECLINED' && <Badge tone="lacquer">Declined</Badge>}
        {v.note && <span className="text-sm">{v.note}</span>}
      </div>
      <p className="text-sm text-fg-soft">
        Written {v.proposedBy ? `by ${v.proposedBy.name} ` : ''}on {when(v.createdAt)}
        {v.approvedAt &&
          `; approved by ${v.approvedBy?.name ?? 'someone'} on ${when(v.approvedAt)}`}
        {v.declinedAt &&
          `; declined by ${v.declinedBy?.name ?? 'someone'} on ${when(v.declinedAt)}${
            v.declineReason ? `: “${v.declineReason}”` : ''
          }`}
      </p>
      <code className="text-xs text-fg-soft">{v.version}</code>
    </div>
  );
}

function TemplateToggle({ template, label }: { template: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onPress={() => setOpen(!open)} aria-expanded={open}>
        {open ? `Hide ${label}` : `Show ${label}`}
      </Button>
      {open && (
        <pre
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable sample must be reachable by keyboard (axe: scrollable-region-focusable)
          tabIndex={0}
          className="mt-2 max-h-96 w-full overflow-auto rounded-card bg-rail p-3 font-mono text-[13px] whitespace-pre-wrap"
        >
          {template}
        </pre>
      )}
    </>
  );
}

/** Every version to pick from: the default, then the Prompt Versions, oldest first. */
function versionOptions(prompt: PromptDetailView) {
  return [
    { id: '0', label: 'Default' },
    ...[...prompt.versions].reverse().map((v) => ({
      id: String(v.number),
      label: versionLabel(v.number),
      description: v.status === 'PROPOSED' ? 'waiting for approval' : v.status.toLowerCase(),
    })),
  ];
}

function CompareVersions({ prompt }: { prompt: PromptDetailView }) {
  const options = versionOptions(prompt);
  // Until picked: from the active version to the newest one.
  const [pickedFrom, setFrom] = useState('');
  const [pickedTo, setTo] = useState('');
  const from = pickedFrom || String(prompt.active.number);
  const to = pickedTo || String(prompt.versions[0]?.number ?? 0);
  const [diff, setDiff] = useState<PromptDiff>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  if (!prompt.versions.length) return null;
  return (
    <Section title="Compare versions">
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Select label="From" options={options} value={from} onChange={setFrom} className="w-40" />
        <Select label="To" options={options} value={to} onChange={setTo} className="w-40" />
        <Button
          isDisabled={pending || from === to}
          onPress={() =>
            start(async () => {
              const result = await promptDiff(prompt.name, Number(from), Number(to));
              if ('failure' in result) {
                setError(result.failure);
                setDiff(undefined);
              } else {
                setError(undefined);
                setDiff(result);
              }
            })
          }
        >
          Show the diff
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-lacquer">
          {error}
        </p>
      )}
      {diff && (
        <div className="mt-4">
          <VersionDiff
            diff={diff}
            caption={`${versionLabel(diff.from)} → ${versionLabel(diff.to)}`}
          />
        </div>
      )}
    </Section>
  );
}

function WriteVersion({ prompt }: { prompt: PromptDetailView }) {
  const active =
    prompt.versions.find((v) => v.number === prompt.active.number)?.template ??
    prompt.default.template;
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(active);
  const [note, setNote] = useState('');
  const action = useAction();
  const templateId = useId();
  return (
    <Section title="Write a version">
      <p className="mt-1 text-sm text-fg-soft">
        A version you write is a proposal: nothing changes until an Admin approves it. Keep every{' '}
        <code>{'{{placeholder}}'}</code>: each one is input the AI needs.
      </p>
      {!open ? (
        <Button className="mt-3" onPress={() => setOpen(true)}>
          Write a new version
        </Button>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () => proposePromptVersion(prompt.name, { template, note: note.trim() || null }),
              'Proposed. Run evals on it, then approve it.',
              () => setOpen(false),
            );
          }}
        >
          <div>
            <label htmlFor={templateId} className="text-sm">
              Prompt
            </label>
            <textarea
              id={templateId}
              className={`${field} h-96 font-mono text-[13px]`}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              required
            />
          </div>
          <label className="block text-sm">
            What it changes, and why
            <input className={field} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" isDisabled={action.pending || !template.trim()}>
              Propose
            </Button>
            <Button variant="ghost" onPress={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <Status message={action.message} />
    </Section>
  );
}

function History({ prompt }: { prompt: PromptDetailView }) {
  return (
    <Section title="History">
      {prompt.history.length === 0 ? (
        <p className="mt-2 text-fg-soft">The default has always been active.</p>
      ) : (
        <ol className="mt-2 space-y-1 text-sm">
          {prompt.history.map((h) => (
            <li key={`${h.at}-${h.kind}-${h.number}`}>
              {when(h.at)}: {h.kind === 'APPROVE' ? 'approved' : 'rolled back to'}{' '}
              <strong>{versionLabel(h.number)}</strong>
              {h.by && ` by ${h.by.name}`}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

// ─── Evals ──────────────────────────────────────────────────────────────────

function Evals({
  prompt,
  models,
}: {
  prompt: PromptDetailView;
  models: ApprovedModelSettingsView[];
}) {
  const checkedIn = prompt.evalSets.reduce((sum, s) => sum + s.cases, 0);
  // Until picked: the newest version.
  const [pickedVersion, setVersion] = useState('');
  const version = pickedVersion || String(prompt.versions[0]?.number ?? 0);
  const [model, setModel] = useState(models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? '');
  const [sources, setSources] = useState<PromptEvalSource[]>(
    checkedIn ? ['CHECKED_IN'] : prompt.replay.receipts ? ['REPLAY'] : [],
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, start] = useTransition();
  const toggle = (source: PromptEvalSource, on: boolean) =>
    setSources((s) => (on ? [...new Set([...s, source])] : s.filter((x) => x !== source)));

  return (
    <Section title="Evals">
      <p className="mt-1 text-sm text-fg-soft">
        Run a version on the checked-in eval cases
        {prompt.evalSets.length > 0 &&
          ` (${prompt.evalSets.map((s) => `${setLabel(s.set)}: ${s.cases}`).join(', ')})`}
        {prompt.replay.supported && ', or replay approved Receipts against what people approved'}.
        It runs on a real model and costs tokens.
      </p>
      {models.length === 0 ? (
        <p className="mt-3 text-fg-soft">Approve a model in AI models first.</p>
      ) : (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setMessage(undefined);
              const result = await startPromptEval(prompt.name, {
                version: Number(version),
                approvedModelId: model,
                sources,
              });
              setMessage(
                result.error
                  ? { ok: false, text: result.error }
                  : { ok: true, text: 'The eval run started.' },
              );
            });
          }}
        >
          <Select
            label="Version"
            options={versionOptions(prompt)}
            value={version}
            onChange={setVersion}
            className="w-44"
          />
          <Select
            label="Model"
            options={models.map((m) => ({
              id: m.id,
              label: m.displayName,
              description: m.modelId,
            }))}
            value={model}
            onChange={setModel}
            className="w-56"
          />
          <div className="space-y-1">
            <Checkbox
              isSelected={sources.includes('CHECKED_IN')}
              isDisabled={!checkedIn}
              onChange={(on) => toggle('CHECKED_IN', on)}
            >
              Eval cases ({checkedIn})
            </Checkbox>
            <Checkbox
              isSelected={sources.includes('REPLAY')}
              isDisabled={!prompt.replay.receipts}
              onChange={(on) => toggle('REPLAY', on)}
            >
              Replay approved Receipts ({prompt.replay.receipts})
            </Checkbox>
          </div>
          <Button type="submit" variant="primary" isDisabled={pending || !model || !sources.length}>
            Run evals
          </Button>
        </form>
      )}
      <Status message={message} />
      <Runs prompt={prompt} />
    </Section>
  );
}

function Progress({ run }: { run: PromptEvalRunSummary }) {
  const share = run.total ? run.done / run.total : 0;
  return (
    <div
      role="progressbar"
      aria-label={`Eval run of ${versionLabel(run.number)}`}
      aria-valuemin={0}
      aria-valuemax={run.total}
      aria-valuenow={run.done}
      className="h-1.5 w-24 overflow-hidden rounded-full bg-rail"
    >
      <div className="h-full bg-jade" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function Runs({ prompt }: { prompt: PromptDetailView }) {
  // Until picked, the two newest runs that are done: the older as A, the newer as B.
  const [pickedA, setA] = useState('');
  const [pickedB, setB] = useState('');
  const [comparison, setComparison] = useState<PromptEvalComparison>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  if (!prompt.runs.length) return <p className="mt-4 text-fg-soft">No eval runs yet.</p>;
  const done = prompt.runs.filter((r) => r.status === 'DONE');
  const a = pickedA || done[1]?.id || '';
  const b = pickedB || done[0]?.id || '';
  const runOptions = done.map((r) => ({
    id: r.id,
    label: `${versionLabel(r.number)} on ${r.model.displayName}`,
    description: `${percent(r.score)}, ${when(r.createdAt)}`,
  }));

  return (
    <div className="mt-6">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Eval runs</caption>
        <thead className="text-fg-soft">
          <tr>
            <th className="py-2 font-medium">Version</th>
            <th className="py-2 font-medium">Model</th>
            <th className="py-2 font-medium">Progress</th>
            <th className="py-2 font-medium">Score</th>
            <th className="py-2 font-medium">Tokens in / out</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {prompt.runs.map((run) => (
            <RunRow key={run.id} prompt={prompt.name} run={run} />
          ))}
        </tbody>
      </table>

      {done.length >= 2 && (
        <div className="mt-6">
          <h4 className="font-semibold">Compare two runs</h4>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <Select label="Run A" options={runOptions} value={a} onChange={setA} className="w-64" />
            <Select label="Run B" options={runOptions} value={b} onChange={setB} className="w-64" />
            <Button
              isDisabled={pending || !a || !b || a === b}
              onPress={() =>
                start(async () => {
                  const result = await comparePromptRuns(prompt.name, a, b);
                  if ('failure' in result) {
                    setError(result.failure);
                    setComparison(undefined);
                  } else {
                    setError(undefined);
                    setComparison(result);
                  }
                })
              }
            >
              Compare
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-lacquer">
              {error}
            </p>
          )}
          {comparison && <Comparison comparison={comparison} />}
        </div>
      )}
    </div>
  );
}

function RunRow({ prompt, run }: { prompt: string; run: PromptEvalRunSummary }) {
  const [details, setDetails] = useState<PromptEvalRunView | string>();
  const [pending, start] = useTransition();
  return (
    <>
      <tr className="border-t border-line" data-testid="eval-run">
        <td className="py-2">
          {versionLabel(run.number)}
          <span className="block text-xs text-fg-soft">
            {run.sources.map((s) => (s === 'REPLAY' ? 'replay' : 'eval cases')).join(' + ')}
          </span>
        </td>
        <td className="py-2">{run.model.displayName}</td>
        <td className="py-2">
          <div className="flex items-center gap-2">
            <Progress run={run} />
            <span>
              {run.done}/{run.total}
            </span>
          </div>
          {run.status === 'FAILED' && (
            <span className="block text-xs text-lacquer">{run.error ?? 'Failed'}</span>
          )}
        </td>
        <td className="py-2" data-testid="eval-score">
          {run.status === 'RUNNING' ? 'Running…' : percent(run.score)}
          {run.setScores.length > 1 && (
            <span className="block text-xs text-fg-soft">
              {run.setScores.map((s) => `${setLabel(s.set)} ${percent(s.score)}`).join(', ')}
            </span>
          )}
        </td>
        <td className="py-2">
          {tokens(run.usage.inputTokens)} / {tokens(run.usage.outputTokens)}
        </td>
        <td className="py-2 text-right">
          <Button
            variant="ghost"
            size="sm"
            isDisabled={pending}
            aria-expanded={Boolean(details)}
            onPress={() =>
              details
                ? setDetails(undefined)
                : start(async () => {
                    const result = await promptEvalRun(prompt, run.id);
                    setDetails('failure' in result ? result.failure : result);
                  })
            }
          >
            {details ? 'Hide cases' : 'Cases'}
          </Button>
        </td>
      </tr>
      {details && (
        <tr>
          <td colSpan={6} className="pb-4">
            {typeof details === 'string' ? (
              <p role="alert" className="text-lacquer">
                {details}
              </p>
            ) : (
              <CaseList cases={details.cases} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function CaseList({ cases }: { cases: PromptEvalCaseView[] }) {
  return (
    <ul className="space-y-2">
      {cases.map((c) => (
        <li key={c.key} className="rounded-card bg-rail p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="text-xs text-fg-soft">{setLabel(c.set)} · </span>
              {c.name}
            </span>
            <strong>{percent(c.score)}</strong>
          </div>
          <ul className="mt-1 text-xs">
            {c.checks.map((check) => (
              <li key={check.name} className={check.passed ? 'text-jade' : 'text-lacquer'}>
                {check.passed ? '✓' : '✗'} {check.name}
                {check.detail && <span className="text-fg-soft">: {check.detail}</span>}
              </li>
            ))}
          </ul>
          {c.error && <p className="mt-1 text-xs text-lacquer">{c.error}</p>}
        </li>
      ))}
    </ul>
  );
}

function Sample({ output }: { output: unknown }) {
  return (
    <pre
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable sample must be reachable by keyboard (axe: scrollable-region-focusable)
      tabIndex={0}
      className="max-h-64 overflow-auto rounded-tile bg-bg p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {output === null ? '(no output)' : JSON.stringify(output, null, 2)}
    </pre>
  );
}

function Comparison({ comparison }: { comparison: PromptEvalComparison }) {
  const head = (run: PromptEvalRunSummary) =>
    `${versionLabel(run.number)} on ${run.model.displayName}`;
  return (
    <div className="mt-4 space-y-4" data-testid="eval-comparison">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Scores per eval set</caption>
        <thead className="text-fg-soft">
          <tr>
            <th className="py-2 font-medium">Eval set</th>
            <th className="py-2 font-medium">A: {head(comparison.a)}</th>
            <th className="py-2 font-medium">B: {head(comparison.b)}</th>
          </tr>
        </thead>
        <tbody>
          {comparison.sets.map((s) => (
            <tr key={s.set} className="border-t border-line">
              <td className="py-2">{setLabel(s.set)}</td>
              <td className="py-2">{percent(s.a)}</td>
              <td className="py-2">{percent(s.b)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <td className="py-2">All cases</td>
            <td className="py-2">{percent(comparison.a.score)}</td>
            <td className="py-2">{percent(comparison.b.score)}</td>
          </tr>
        </tbody>
      </table>
      <ul className="space-y-2">
        {comparison.cases.map((c) => (
          <li key={c.key}>
            <details className="rounded-card bg-rail p-3">
              <summary className="flex cursor-default flex-wrap justify-between gap-2">
                <span>{c.name}</span>
                <span>
                  A {percent(c.a?.score ?? null)} · B {percent(c.b?.score ?? null)}
                </span>
              </summary>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div>
                  <p className="text-xs text-fg-soft">A</p>
                  <Sample output={c.a?.output ?? null} />
                </div>
                <div>
                  <p className="text-xs text-fg-soft">B</p>
                  <Sample output={c.b?.output ?? null} />
                </div>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
