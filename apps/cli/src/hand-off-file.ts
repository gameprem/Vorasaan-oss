import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isHandOffSlug } from '@vorasaan/shared';
import { ConfigError } from './config.ts';
import { REPO_CONFIG_DIR } from './repo.ts';

/**
 * Where `vorasaan run` writes a Feature's Hand-off (ticket 0079): `.vorasaan/specs/<slug>.md`
 * at the repository root, and nowhere else. The name comes from the server's slug, which is
 * checked again here: letters and digits joined by `-`, so it has no dot, slash or backslash.
 * A `.vorasaan` or `specs` directory that is a symlink, or resolves outside the repository, is
 * refused, as is a symlink where the file goes; the file is written to a fresh temporary file
 * (`wx`: never through an existing path) and renamed over the old one.
 */
export const HAND_OFF_DIR = 'specs';
export const HAND_OFF_RELATIVE_DIR = `${REPO_CONFIG_DIR}/${HAND_OFF_DIR}`;

const FEATURE_LINE = /^vorasaan-feature: ([0-9a-f-]{36})$/m;

async function stat(path: string) {
  return lstat(path).catch(() => undefined);
}

/** Refuses a `.vorasaan` or `.vorasaan/specs` that is a symlink, isn't a directory, or escapes. */
async function assertSafeDirs(root: string) {
  const realRoot = await realpath(root);
  for (const rel of [REPO_CONFIG_DIR, join(REPO_CONFIG_DIR, HAND_OFF_DIR)]) {
    const path = join(root, rel);
    const found = await stat(path);
    if (!found) continue;
    if (found.isSymbolicLink()) {
      throw new ConfigError(`${path} is a symlink; refusing to write outside the repository.`);
    }
    if (!found.isDirectory()) throw new ConfigError(`${path} is not a directory.`);
    if (relative(realRoot, await realpath(path)) !== rel) {
      throw new ConfigError(`${path} resolves outside the repository root.`);
    }
  }
}

/** The Feature a Hand-off file was written for, from its front matter; undefined if none. */
async function featureOfFile(path: string): Promise<string | undefined> {
  const head = await readFile(path, 'utf8').then(
    (text) => text.slice(0, 500),
    () => '',
  );
  return FEATURE_LINE.exec(head)?.[1];
}

/**
 * The file a Feature's Hand-off goes to: `<slug>.md`, unless that holds another Feature's
 * Hand-off or a file of someone else's; then `<slug>-<id>.md` (the id's first 8 characters).
 */
async function target(specs: string, slug: string, featureId: string): Promise<string> {
  const short = featureId.replace(/[^0-9a-f]/gi, '').slice(0, 8);
  for (const name of [slug, `${slug}-${short}`]) {
    const path = join(specs, `${name}.md`);
    const found = await stat(path);
    if (!found) return path;
    if (found.isSymbolicLink()) {
      throw new ConfigError(`${path} is a symlink; refusing to write through it.`);
    }
    if (found.isFile() && (await featureOfFile(path)) === featureId) return path;
  }
  throw new ConfigError(
    `${join(specs, `${slug}.md`)} and its alternative hold other files; move them and run again.`,
  );
}

export type WrittenHandOff = {
  /** The absolute path. */
  path: string;
  /** From the repository root, with forward slashes: `.vorasaan/specs/async-checkout.md`. */
  relativePath: string;
};

/** Writes `markdown` as the Feature's Hand-off under `root`, atomically. */
export async function writeHandOff(
  root: string,
  slug: string,
  featureId: string,
  markdown: string,
): Promise<WrittenHandOff> {
  if (!isHandOffSlug(slug)) {
    throw new ConfigError(`The server sent an unusable file name "${slug}"; nothing was written.`);
  }
  const specs = join(root, REPO_CONFIG_DIR, HAND_OFF_DIR);
  await assertSafeDirs(root);
  await mkdir(specs, { recursive: true });
  await assertSafeDirs(root);
  const path = await target(specs, slug, featureId);
  if (dirname(path) !== specs) throw new ConfigError(`Refusing to write ${path}.`);
  const tmp = join(specs, `.${process.pid}.${Date.now()}.tmp`);
  // `wx` refuses an existing path (a planted symlink included) instead of following it.
  await writeFile(tmp, markdown, { flag: 'wx', mode: 0o644 });
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { path, relativePath: relative(root, path).split(sep).join('/') };
}

/**
 * Whether git ignores the file: true or false, or undefined when git can't tell (no git, or
 * not a repository). A Hand-off is a snapshot of the server's data, so it is best left out of
 * commits; `vorasaan run` suggests the .gitignore line when it isn't.
 */
export async function gitIgnores(root: string, relativePath: string): Promise<boolean | undefined> {
  try {
    const proc = Bun.spawn(['git', 'check-ignore', '-q', '--', relativePath], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const code = await proc.exited;
    if (code === 0) return true;
    if (code === 1) return false;
    return undefined;
  } catch {
    return undefined;
  }
}
