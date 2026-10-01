import * as p from '@clack/prompts';
import type { ProjectView } from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import { ConfigError } from '../config.ts';
import {
  findRepoRoot,
  REPO_CONFIG_DIR,
  REPO_CONFIG_FILE,
  type RepoBinding,
  readRepoBinding,
  writeRepoBinding,
} from '../repo.ts';
import { UsageError } from './raise-options.ts';
import { runScan, type ScanDeps, type ScanOptions } from './scan.ts';

export type InitOptions = {
  /** A directory inside the repository; the binding goes to the repository root. */
  dir: string;
  /** Skips the picker. */
  projectId?: string;
  /** Recorded in the binding so it only applies when the CLI talks to that server. */
  apiUrl?: string;
  /** Then run the Repo Scan (0033) for the bound Project. */
  scan: boolean;
  dryRun: boolean;
  /** Replace an existing binding and send the scan without asking. */
  yes: boolean;
};

export type InitDeps = {
  api: () => Promise<VorasaanApi>;
  /** Returns the chosen Project id, or undefined when the user cancels. */
  pickProject: (projects: ProjectView[], currentId?: string) => Promise<string | undefined>;
  confirm: (message: string) => Promise<boolean>;
  print: (text: string) => void;
  /** The Repo Scan command; injectable for tests. */
  scan?: (options: ScanOptions, deps: ScanDeps) => Promise<unknown>;
};

const RELATIVE_PATH = `${REPO_CONFIG_DIR}/${REPO_CONFIG_FILE}`;

/**
 * `vorasaan init`: binds the repository to a Project by writing
 * `.vorasaan/config.json` (`{ projectId, apiUrl? }`, never a token) at the
 * repository root. An existing binding is only replaced after a confirm.
 * With `--scan`, runs the Repo Scan for the bound Project (with its own confirm).
 */
export async function runInit(
  options: InitOptions,
  deps: InitDeps,
): Promise<RepoBinding | undefined> {
  const root = await findRepoRoot(options.dir);
  let existing: RepoBinding | undefined;
  try {
    existing = await readRepoBinding(root);
  } catch (error) {
    // An unreadable binding can be replaced; a symlinked one cannot (writeRepoBinding refuses).
    if (!(error instanceof ConfigError)) throw error;
    deps.print(`${error.message}`);
  }

  const api = await deps.api();
  const projects = await api.listProjects();
  if (projects.length === 0) {
    throw new UsageError('There are no Projects yet. An Admin creates them in the web app.');
  }
  const nameOf = (id: string) => projects.find((pr) => pr.id === id)?.name ?? id;

  let projectId = options.projectId;
  if (projectId !== undefined && !projects.some((pr) => pr.id === projectId)) {
    throw new UsageError(`No Project with id ${projectId}.`);
  }
  projectId ??= await deps.pickProject(projects, existing?.projectId);
  if (!projectId) {
    deps.print('Cancelled. Nothing was written.');
    return undefined;
  }

  const wanted: RepoBinding = options.apiUrl
    ? { projectId, apiUrl: options.apiUrl }
    : { projectId };
  let bound = wanted;
  const same =
    existing && existing.projectId === wanted.projectId && existing.apiUrl === wanted.apiUrl;
  if (same && existing) {
    bound = existing;
    deps.print(`${RELATIVE_PATH} already binds ${root} to "${nameOf(projectId)}".`);
  } else {
    const replace =
      !existing ||
      options.yes ||
      (await deps.confirm(
        `${RELATIVE_PATH} binds this repository to "${nameOf(existing.projectId)}". Replace it with "${nameOf(projectId)}"?`,
      ));
    if (replace) {
      await writeRepoBinding(root, wanted);
      deps.print(
        `Bound ${root} to the Project "${nameOf(projectId)}" in ${RELATIVE_PATH}. Commit it to share the binding; it holds no token.`,
      );
    } else if (existing) {
      bound = existing;
      deps.print(`Kept the existing binding to "${nameOf(existing.projectId)}".`);
    }
  }

  if (options.scan) {
    await (deps.scan ?? runScan)(
      { projectId: bound.projectId, dir: root, dryRun: options.dryRun, yes: options.yes },
      { api: deps.api, confirm: deps.confirm, print: deps.print },
    );
  }
  return bound;
}

function needsTerminal(): never {
  throw new UsageError(
    'Cannot ask without a terminal. Pass --project <id> (and --yes to replace an existing binding).',
  );
}

/** The interactive Project picker (clack). */
export async function pickProjectInTerminal(
  projects: ProjectView[],
  currentId?: string,
): Promise<string | undefined> {
  if (!process.stdin.isTTY) needsTerminal();
  const choice = await p.select<string>({
    message: 'Which Project is this repository part of?',
    initialValue: currentId ?? projects[0]?.id,
    options: projects.map((pr) => ({
      value: pr.id,
      label: pr.name,
      hint: [pr.jiraKey, pr.id === currentId ? 'current binding' : undefined]
        .filter(Boolean)
        .join(' · '),
    })),
  });
  return p.isCancel(choice) ? undefined : choice;
}
