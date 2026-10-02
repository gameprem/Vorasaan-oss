import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ConfigError } from './config.ts';

/**
 * The repo binding: `.vorasaan/config.json` at the repository root, written by
 * `vorasaan init`. It holds only which Project the repo belongs to (and, when
 * given, which server that Project lives on). Never a token: those stay in the
 * user config (`~/.config/vorasaan/config.json`).
 */
export type RepoBinding = { projectId: string; apiUrl?: string };

export const REPO_CONFIG_DIR = '.vorasaan';
export const REPO_CONFIG_FILE = 'config.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The git top-level of `dir`, else the nearest ancestor holding `.git`, else `dir` itself. */
export async function findRepoRoot(dir: string): Promise<string> {
  const start = resolve(dir);
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
      cwd: start,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && out) return await realpath(out);
  } catch {
    // No git binary: fall back to looking for .git ourselves.
  }
  for (let current = start; ; current = dirname(current)) {
    if (await exists(join(current, '.git'))) return current;
    if (dirname(current) === current) return start;
  }
}

export function repoConfigPath(root: string): string {
  return join(root, REPO_CONFIG_DIR, REPO_CONFIG_FILE);
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses a `.vorasaan` directory or config file that is a symlink, so neither a
 * read nor a write can be redirected outside the repository root.
 */
async function assertInsideRoot(root: string) {
  const dir = join(root, REPO_CONFIG_DIR);
  for (const path of [dir, repoConfigPath(root)]) {
    const stat = await lstat(path).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      throw new ConfigError(`${path} is a symlink; refusing to follow it outside the repository.`);
    }
  }
  const realRoot = await realpath(root);
  const realDir = await realpath(dir).catch(() => undefined);
  if (realDir && relative(realRoot, realDir) !== REPO_CONFIG_DIR) {
    throw new ConfigError(`${dir} resolves outside the repository root.`);
  }
}

/** Only the known keys, validated; anything else in the file is ignored. */
export function parseRepoBinding(raw: unknown, path: string): RepoBinding {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { projectId, apiUrl } = value;
  if (typeof projectId !== 'string' || !isUuid(projectId)) {
    throw new ConfigError(`${path} has no valid "projectId". Run \`vorasaan init\` again.`);
  }
  if (apiUrl !== undefined && (typeof apiUrl !== 'string' || !URL.canParse(apiUrl))) {
    throw new ConfigError(`${path} has an invalid "apiUrl".`);
  }
  return apiUrl === undefined ? { projectId } : { projectId, apiUrl };
}

export async function readRepoBinding(root: string): Promise<RepoBinding | undefined> {
  const path = repoConfigPath(root);
  if (!(await exists(path))) return undefined;
  await assertInsideRoot(root);
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Run \`vorasaan init\` again.`);
  }
  return parseRepoBinding(raw, path);
}

/** Writes exactly `{ projectId, apiUrl? }` (never a token), atomically. */
export async function writeRepoBinding(root: string, binding: RepoBinding): Promise<string> {
  const clean = parseRepoBinding(
    { projectId: binding.projectId, apiUrl: binding.apiUrl },
    repoConfigPath(root),
  );
  await assertInsideRoot(root);
  await mkdir(join(root, REPO_CONFIG_DIR), { recursive: true });
  await assertInsideRoot(root);
  const path = repoConfigPath(root);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  // `wx` refuses an existing path (a planted symlink included) instead of following it.
  await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return path;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * Whether the binding applies to the server the CLI is signed in to. A binding
 * that names another server is ignored (and the token is never sent there).
 */
export function bindingApplies(binding: RepoBinding | undefined, apiUrl: string): boolean {
  if (!binding) return false;
  return binding.apiUrl === undefined || origin(binding.apiUrl) === origin(apiUrl);
}

/** The repository the CLI runs in, as the raise flow and the TUI see it. */
export type CurrentRepo = {
  root: string;
  cwd: string;
  /** The bound Project, when `.vorasaan/config.json` exists and applies to this server. */
  projectId?: string;
  /** Why the binding was ignored (invalid file, another server). */
  notice?: string;
};

export async function currentRepo(cwd: string, apiUrl: string): Promise<CurrentRepo> {
  const root = await findRepoRoot(cwd);
  try {
    const binding = await readRepoBinding(root);
    if (!binding) return { root, cwd };
    if (!bindingApplies(binding, apiUrl)) {
      return {
        root,
        cwd,
        notice: `.vorasaan/config.json binds this repository to a Project on ${binding.apiUrl}, not ${apiUrl}; ignoring it.`,
      };
    }
    return { root, cwd, projectId: binding.projectId };
  } catch (error) {
    if (error instanceof ConfigError) return { root, cwd, notice: error.message };
    throw error;
  }
}
