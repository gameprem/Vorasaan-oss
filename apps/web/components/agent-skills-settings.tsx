'use client';

import type {
  AgentSkillDiff,
  AgentSkillsView,
  AgentSkillVersionView,
  AgentSkillView,
  SkippedSkillFileReason,
} from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useRef, useState, useTransition } from 'react';
import {
  approveAgentSkillVersion,
  declineAgentSkillVersion,
  installAgentSkill,
  type SkillActionResult,
  setAgentSkillProjects,
  uninstallAgentSkill,
  updateAgentSkill,
} from '@/lib/agent-skill-actions';
import { VersionDiff } from './spec-diff';
import { field } from './ui';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog } from './ui/dialog';

// Settings → Agent Skills (ADR 0017, ticket 0078): an Admin installs an Agent Skill from a
// GitHub URL or a zip, reads what it holds (and what was left out) before approving it,
// enables it per Project, updates it (a new version waits for approval, with its diff) and
// uninstalls it. Every message goes to one status line and one alert line that stay on the
// page, so a card that disappears after an action never takes its message with it.

const KiB = 1024;
const size = (bytes: number) =>
  bytes < KiB
    ? `${bytes} B`
    : bytes < KiB * KiB
      ? `${(bytes / KiB).toFixed(1)} KiB`
      : `${(bytes / KiB / KiB).toFixed(1)} MiB`;
const when = (iso: string) => new Date(iso).toLocaleDateString('en', { dateStyle: 'medium' });
const short = (pinned: string) =>
  pinned.startsWith('sha256:') ? `zip ${pinned.slice(7, 19)}` : `commit ${pinned.slice(0, 7)}`;

const SKIPPED: Record<SkippedSkillFileReason, string> = {
  SCRIPT: 'script',
  NOT_TEXT: 'not text',
  LINK: 'link',
};

type Report = (result: SkillActionResult, done?: () => void) => void;

export function AgentSkillsSettings({
  view,
  diffs,
}: {
  view: AgentSkillsView;
  diffs: Record<string, AgentSkillDiff>;
}) {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const listHeading = useRef<HTMLHeadingElement>(null);
  const report: Report = (result, done) => {
    if (result.error) {
      setStatus('');
      setError(result.error);
    } else {
      setError('');
      setStatus(result.message ?? 'Done.');
      done?.();
      router.refresh();
    }
  };
  const clear = () => {
    setStatus('');
    setError('');
  };

  return (
    <div className="mt-8 space-y-10">
      {/* Always on the page, so what an action says is never removed with what it changed. */}
      <div className="space-y-1">
        <p role="status" className="text-jade" data-testid="skills-status">
          {status}
        </p>
        <p role="alert" className="text-lacquer" data-testid="skills-error">
          {error}
        </p>
      </div>

      <InstallForms report={report} clear={clear} limits={view.limits} />

      <section aria-labelledby="installed-skills">
        <h3
          id="installed-skills"
          ref={listHeading}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          Installed Agent Skills
        </h3>
        {view.skills.length === 0 ? (
          <p className="mt-2 text-fg-soft">No Agent Skill is installed yet.</p>
        ) : (
          <ul className="mt-4 space-y-6">
            {view.skills.map((skill) => (
              <li key={skill.id}>
                <SkillCard
                  skill={skill}
                  diff={diffs[skill.id]}
                  projects={view.projects}
                  report={report}
                  clear={clear}
                  onRemoved={() => listHeading.current?.focus()}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Install ──────────────────────────────────────────────────────────────────

function InstallForms({
  report,
  clear,
  limits,
}: {
  report: Report;
  clear: () => void;
  limits: AgentSkillsView['limits'];
}) {
  const [pending, start] = useTransition();
  const githubForm = useRef<HTMLFormElement>(null);
  const zipForm = useRef<HTMLFormElement>(null);
  const ids = {
    url: useId(),
    urlHint: useId(),
    folder: useId(),
    file: useId(),
    zipFolder: useId(),
  };

  const installFromGitHub = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    clear();
    start(async () => {
      const result = await installAgentSkill({
        url: String(data.get('url') ?? ''),
        subpath: String(data.get('subpath') ?? ''),
      });
      report(result, () => githubForm.current?.reset());
    });
  };

  const installFromZip = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    clear();
    start(async () => {
      report(await uploadZip('/api/settings/agent-skills/zip', data), () =>
        zipForm.current?.reset(),
      );
    });
  };

  return (
    <section aria-labelledby="install-skill">
      <h3 id="install-skill" className="text-lg font-semibold">
        Install an Agent Skill
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        A Skill is a folder with a SKILL.md, plus references and assets, as coding assistants use
        them. It is pinned to the commit or the zip installed. Scripts and other programs in it are
        left out and never run. Up to {size(limits.maxFileBytes)} a file and{' '}
        {size(limits.maxSkillBytes)} a Skill.
      </p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <form ref={githubForm} onSubmit={installFromGitHub} aria-label="Install from GitHub">
          <h4 className="font-medium">From GitHub</h4>
          <label htmlFor={ids.url} className="mt-2 block text-sm">
            GitHub URL
          </label>
          <input
            id={ids.url}
            name="url"
            type="url"
            required
            inputMode="url"
            placeholder="https://github.com/owner/repo/tree/main/skill"
            aria-describedby={ids.urlHint}
            className={field}
          />
          <p id={ids.urlHint} className="mt-1 text-sm text-fg-soft">
            The repository, or the Skill’s folder in it.
          </p>
          <label htmlFor={ids.folder} className="mt-3 block text-sm">
            Folder (optional)
          </label>
          <input id={ids.folder} name="subpath" maxLength={300} className={field} />
          <Button type="submit" variant="primary" className="mt-4" isDisabled={pending}>
            {pending ? 'Installing…' : 'Install from GitHub'}
          </Button>
        </form>

        <form ref={zipForm} onSubmit={installFromZip} aria-label="Install from a zip">
          <h4 className="font-medium">From a zip</h4>
          <label htmlFor={ids.file} className="mt-2 block text-sm">
            Zip file
          </label>
          <input
            id={ids.file}
            name="file"
            type="file"
            required
            accept=".zip,application/zip"
            className={`${field} text-sm`}
          />
          <label htmlFor={ids.zipFolder} className="mt-3 block text-sm">
            Folder in the zip (optional)
          </label>
          <input id={ids.zipFolder} name="subpath" maxLength={300} className={field} />
          <Button type="submit" variant="primary" className="mt-4" isDisabled={pending}>
            {pending ? 'Uploading…' : 'Install from zip'}
          </Button>
        </form>
      </div>
    </section>
  );
}

/** Posts a zip (and its folder, first, as the API reads fields before the file). */
async function uploadZip(url: string, data: FormData): Promise<SkillActionResult> {
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a zip file.' };
  const body = new FormData();
  const subpath = String(data.get('subpath') ?? '').trim();
  if (subpath) body.append('subpath', subpath);
  body.append('file', file);
  try {
    const res = await fetch(url, { method: 'POST', body });
    const reply = (await res.json().catch(() => ({}))) as Partial<
      AgentSkillView & { skill: AgentSkillView; upToDate: boolean; message: unknown }
    >;
    if (!res.ok) {
      return {
        error:
          typeof reply.message === 'string'
            ? reply.message
            : `The upload failed (HTTP ${res.status})`,
      };
    }
    if (reply.skill) {
      return {
        message: reply.upToDate
          ? `${reply.skill.name} is up to date.`
          : `Uploaded version ${reply.skill.pending?.number} of ${reply.skill.name}. Review its changes, then approve or discard it.`,
      };
    }
    return {
      message: `Installed ${reply.name}. Review it, then approve it before the AI can use it.`,
    };
  } catch {
    return { error: 'The upload failed. Check your connection and try again.' };
  }
}

// ─── One Skill ────────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  diff,
  projects,
  report,
  clear,
  onRemoved,
}: {
  skill: AgentSkillView;
  diff: AgentSkillDiff | undefined;
  projects: AgentSkillsView['projects'];
  report: Report;
  clear: () => void;
  onRemoved: () => void;
}) {
  const [pending, start] = useTransition();
  const headingId = useId();
  const shown = skill.active ?? skill.pending;
  const run = (action: () => Promise<SkillActionResult>, done?: () => void) => {
    clear();
    start(async () => report(await action(), done));
  };

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-card bg-rail p-5"
      data-testid={`skill-${skill.name}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={headingId} className="text-base font-semibold">
          {skill.name}
        </h4>
        <span className={skill.active ? 'text-sm text-jade' : 'text-sm text-fg-soft'}>
          {skill.active ? 'Approved' : 'Not approved: the AI can’t use it yet'}
        </span>
      </div>
      {shown && <p className="mt-1 text-fg-soft">{shown.description}</p>}
      <p className="mt-2 text-sm text-fg-soft">
        {skill.source === 'GITHUB' ? (
          <>
            From GitHub:{' '}
            {skill.sourceUrl ? (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {skill.repository}
                {skill.subpath ? `/${skill.subpath}` : ''}
              </a>
            ) : (
              skill.repository
            )}
            {skill.ref ? ` (${skill.ref})` : ' (default branch)'}
          </>
        ) : (
          <>From a zip{skill.subpath ? ` (folder ${skill.subpath})` : ''}</>
        )}
        {shown?.license ? ` · License: ${shown.license}` : ''}
      </p>

      {skill.active && (
        <VersionLine version={skill.active} label={`Version ${skill.active.number}, in use`} />
      )}

      {skill.pending && (
        <PendingVersion
          skill={skill}
          version={skill.pending}
          diff={diff}
          pending={pending}
          onApprove={() =>
            run(() => approveAgentSkillVersion(skill.id, skill.pending?.number ?? 0))
          }
          onDecline={() =>
            run(() => declineAgentSkillVersion(skill.id, skill.pending?.number ?? 0))
          }
        />
      )}

      <ProjectsForm skill={skill} projects={projects} pending={pending} run={run} />

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {skill.source === 'GITHUB' ? (
          <Button
            isDisabled={pending || Boolean(skill.pending)}
            onPress={() => run(() => updateAgentSkill(skill.id))}
          >
            Check for an update
          </Button>
        ) : (
          <ZipUpdate skill={skill} pending={pending} report={report} clear={clear} />
        )}
        <Dialog
          trigger="Uninstall"
          triggerVariant="danger"
          title={`Uninstall ${skill.name}?`}
          role="alertdialog"
        >
          {(close) => (
            <>
              <p>
                The Skill and all its files are deleted, and the AI can’t use it anywhere. Receipts
                keep its name.
              </p>
              <div className="mt-5 flex justify-end gap-3">
                <Button onPress={close}>Cancel</Button>
                <Button
                  variant="danger"
                  isDisabled={pending}
                  onPress={() => {
                    close();
                    run(() => uninstallAgentSkill(skill.id, skill.name), onRemoved);
                  }}
                >
                  Uninstall
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </div>
    </article>
  );
}

function VersionLine({ version, label }: { version: AgentSkillVersionView; label: string }) {
  return (
    <p className="mt-3 text-sm">
      <span className="font-medium">{label}:</span> {short(version.pinned)}, {version.files.length}{' '}
      file{version.files.length === 1 ? '' : 's'} ({size(version.totalBytes)})
      {version.decidedBy ? `, approved by ${version.decidedBy}` : ''}
      {version.decidedAt ? ` on ${when(version.decidedAt)}` : ''}.
    </p>
  );
}

function PendingVersion({
  skill,
  version,
  diff,
  pending,
  onApprove,
  onDecline,
}: {
  skill: AgentSkillView;
  version: AgentSkillVersionView;
  diff: AgentSkillDiff | undefined;
  pending: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const changed = diff?.files.filter((f) => f.change !== 'UNCHANGED') ?? [];
  const unchanged = diff?.files.filter((f) => f.change === 'UNCHANGED') ?? [];
  return (
    <section
      aria-label={`Version ${version.number} waiting for approval`}
      className="mt-4 rounded-tile bg-bg p-4"
    >
      <p className="font-medium">
        Version {version.number} waits for your approval
        {skill.active ? ' (an update)' : ''}: {short(version.pinned)}, {version.files.length} file
        {version.files.length === 1 ? '' : 's'} ({size(version.totalBytes)}).
      </p>
      <p className="mt-1 text-sm text-fg-soft">
        Read what the AI would get before approving it. Its text can only shape what the AI
        proposes; nothing in it is ever run.
      </p>
      {version.skipped.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium">Left out (never stored or run):</p>
          <ul className="mt-1 list-inside list-disc text-sm text-fg-soft">
            {version.skipped.map((s) => (
              <li key={s.path}>
                <code>{s.path}</code> ({SKIPPED[s.reason]})
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Review {diff.from === null ? 'its files' : `the changes from version ${diff.from}`} (
            {changed.length} file{changed.length === 1 ? '' : 's'})
          </summary>
          <div className="mt-3 space-y-4">
            {changed.map((file) => (
              <VersionDiff
                key={file.path}
                diff={{ from: diff.from ?? 0, to: diff.to, lines: file.lines }}
                caption={`${file.path} (${file.change.toLowerCase()})`}
              />
            ))}
            {unchanged.length > 0 && (
              <p className="text-sm text-fg-soft">
                Unchanged: {unchanged.map((f) => f.path).join(', ')}
              </p>
            )}
          </div>
        </details>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="primary" isDisabled={pending} onPress={onApprove}>
          Approve version {version.number}
        </Button>
        <Button variant="danger" isDisabled={pending} onPress={onDecline}>
          Discard version {version.number}
        </Button>
      </div>
    </section>
  );
}

function ProjectsForm({
  skill,
  projects,
  pending,
  run,
}: {
  skill: AgentSkillView;
  projects: AgentSkillsView['projects'];
  pending: boolean;
  run: (action: () => Promise<SkillActionResult>) => void;
}) {
  const [selected, setSelected] = useState(() => new Set(skill.projectIds));
  const labelId = useId();
  const changed =
    selected.size !== skill.projectIds.length || skill.projectIds.some((id) => !selected.has(id));
  if (!projects.length) return null;
  return (
    <fieldset className="mt-4" aria-labelledby={labelId}>
      <legend id={labelId} className="text-sm font-medium">
        Enabled in
      </legend>
      <p className="text-sm text-fg-soft">
        The AI in these Projects sees its name and description, and reads it when it needs it, once
        a version is approved.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {projects.map((project) => (
          <Checkbox
            key={project.id}
            variant="chip"
            isSelected={selected.has(project.id)}
            isDisabled={pending}
            onChange={(on) =>
              setSelected((current) => {
                const next = new Set(current);
                if (on) next.add(project.id);
                else next.delete(project.id);
                return next;
              })
            }
          >
            {project.name}
          </Checkbox>
        ))}
      </div>
      <Button
        size="sm"
        className="mt-3"
        isDisabled={pending || !changed}
        onPress={() => run(() => setAgentSkillProjects(skill.id, [...selected]))}
      >
        Save Projects
      </Button>
    </fieldset>
  );
}

function ZipUpdate({
  skill,
  pending,
  report,
  clear,
}: {
  skill: AgentSkillView;
  pending: boolean;
  report: Report;
  clear: () => void;
}) {
  const [uploading, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const fileId = useId();
  return (
    <form
      ref={form}
      aria-label={`Update ${skill.name} from a new zip`}
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        clear();
        start(async () =>
          report(await uploadZip(`/api/settings/agent-skills/${skill.id}/update/zip`, data), () =>
            form.current?.reset(),
          ),
        );
      }}
    >
      <div>
        <label htmlFor={fileId} className="block text-sm">
          New zip
        </label>
        <input
          id={fileId}
          name="file"
          type="file"
          required
          accept=".zip,application/zip"
          className={`${field} text-sm`}
        />
      </div>
      <Button type="submit" isDisabled={pending || uploading || Boolean(skill.pending)}>
        {uploading ? 'Uploading…' : 'Upload the update'}
      </Button>
    </form>
  );
}
