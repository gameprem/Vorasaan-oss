import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { cutToBytes, isScannable, readInside, redactSecrets } from './repo-scan.ts';

/**
 * Context from the current repository attached to a Decision Request's
 * description: the current diff and/or files the Raiser chose. Secret-looking
 * files are skipped (same rules as the Repo Scan), credential-looking lines are
 * redacted, nothing outside the repository root is read, and everything is capped.
 */
export type RepoContextInput = {
  /** Include `git diff HEAD` (staged and unstaged changes). */
  diff?: boolean;
  /** Paths relative to `cwd` (or the repo root when `cwd` is omitted). */
  files?: string[];
};

export type RepoContext = {
  /** Empty when nothing was attached. */
  markdown: string;
  /** What was requested but left out, with the reason. */
  skipped: string[];
};

export const DIFF_MAX_BYTES = 20_000;
export const FILE_MAX_BYTES = 8_000;
export const MAX_FILES = 5;

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.quotepath=off', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** A code fence longer than any backtick run in `body`, so the body cannot break out. */
function fenced(body: string, lang = ''): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${body.replace(/\n+$/, '')}\n${fence}`;
}

function capped(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false };
  return { text: cutToBytes(text, maxBytes), cut: true };
}

/** `path` as a repo-relative POSIX path, or undefined when it points outside the repo. */
export function toRepoPath(root: string, cwd: string, path: string): string | undefined {
  const rel = relative(root, resolve(cwd, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

async function currentDiff(root: string, skipped: string[]): Promise<string | undefined> {
  // `git diff HEAD` fails before the first commit; fall back to the index.
  const base = (await git(root, 'rev-parse', '--verify', '-q', 'HEAD')) ? ['HEAD'] : ['--cached'];
  const names = await git(root, 'diff', ...base, '--name-only');
  if (names === undefined) {
    skipped.push('diff (not a git repository)');
    return undefined;
  }
  const changed = names.split('\n').filter(Boolean);
  const safe = changed.filter(isScannable);
  for (const name of changed) if (!isScannable(name)) skipped.push(`${name} (secret-looking)`);
  if (safe.length === 0) {
    if (changed.length === 0) skipped.push('diff (no changes)');
    return undefined;
  }
  const diff = await git(root, 'diff', ...base, '--', ...safe.map((f) => `:(literal)${f}`));
  if (!diff?.trim()) return undefined;
  const { text, cut } = capped(redactSecrets(diff), DIFF_MAX_BYTES);
  if (cut) skipped.push(`diff truncated to ${DIFF_MAX_BYTES / 1000} KB`);
  return `**Current diff**\n\n${fenced(text, 'diff')}`;
}

export async function collectRepoContext(
  repoRoot: string,
  input: RepoContextInput,
  cwd: string = repoRoot,
): Promise<RepoContext> {
  const root = await realpath(repoRoot);
  const skipped: string[] = [];
  const parts: string[] = [];

  if (input.diff) {
    const diff = await currentDiff(root, skipped);
    if (diff) parts.push(diff);
  }

  const files = [...new Set(input.files ?? [])];
  for (const [i, file] of files.entries()) {
    if (i >= MAX_FILES) {
      skipped.push(`${file} (at most ${MAX_FILES} files)`);
      continue;
    }
    const rel = toRepoPath(root, cwd, file);
    if (!rel) {
      skipped.push(`${file} (outside the repository)`);
      continue;
    }
    if (!isScannable(rel)) {
      skipped.push(`${rel} (secret-looking or ignored)`);
      continue;
    }
    const content = await readInside(root, rel, FILE_MAX_BYTES + 1);
    if (content === null) {
      skipped.push(`${rel} (not a readable file in the repository)`);
      continue;
    }
    const { text, cut } = capped(redactSecrets(content), FILE_MAX_BYTES);
    if (cut) skipped.push(`${rel} truncated to ${FILE_MAX_BYTES / 1000} KB`);
    parts.push(`**\`${rel}\`**\n\n${fenced(text)}`);
  }

  if (parts.length === 0) return { markdown: '', skipped };
  return {
    markdown: `**Context from the repository \`${basename(root)}\`**\n\n${parts.join('\n\n')}`,
    skipped,
  };
}

/** The description the server receives: the Raiser's text, then the repository context. */
export function describeWithContext(description: string, context: RepoContext): string {
  return context.markdown ? `${description.trim()}\n\n---\n\n${context.markdown}` : description;
}
