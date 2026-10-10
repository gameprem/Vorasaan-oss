// Fetching an Agent Skill from GitHub (ADR 0017, ticket 0078), guarded against SSRF: only
// `https` to GitHub's own API and download hosts, never a redirect off them, no credentials or
// ports in a URL, and every body read with a size cap. The commit a ref points at is resolved
// first, and the zip is downloaded at that commit, so the install is pinned to it.

/** The GitHub URL or its fetch is refused or failed (a 422 for the Admin). */
export class GitHubSourceError extends Error {}

/** A download over the archive limit (refused, like a Skill over its limits). */
export class GitHubTooLargeError extends GitHubSourceError {}

/** Where a Skill is in GitHub: a repository, a ref (null: its default branch) and a folder. */
export type GitHubTarget = { owner: string; repo: string; ref: string | null; subpath: string };

/** The `fetch` the server uses for GitHub; tests give a fake GitHub server instead. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;
export const AGENT_SKILL_FETCH = Symbol('AGENT_SKILL_FETCH');

/** The hosts a pasted URL may name. */
const PASTE_HOSTS = new Set(['github.com', 'www.github.com']);
/** The only hosts fetched, redirects included. */
export const FETCH_HOSTS = new Set(['api.github.com', 'codeload.github.com']);

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
const MAX_REDIRECTS = 3;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Reads a pasted GitHub URL: `https://github.com/<owner>/<repo>`, optionally
 * `/tree/<ref>/<folder>` or `/blob/<ref>/<folder>/SKILL.md` (a ref is one path segment
 * there). A `subpath` given separately names the folder instead of the URL's.
 */
export function parseGitHubUrl(input: string, subpath?: string): GitHubTarget {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GitHubSourceError('That is not a URL');
  }
  if (url.protocol !== 'https:')
    throw new GitHubSourceError('Only https:// GitHub URLs are allowed');
  if (!PASTE_HOSTS.has(url.hostname.toLowerCase()) || url.port) {
    throw new GitHubSourceError('Only github.com URLs are allowed');
  }
  if (url.username || url.password)
    throw new GitHubSourceError('The URL must not hold credentials');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [owner = '', rawRepo = '', kind, ref, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith('.') || repo.startsWith('.')) {
    throw new GitHubSourceError(
      'The URL must name a repository: https://github.com/<owner>/<repo>',
    );
  }
  let folder = '';
  let pinnedRef: string | null = null;
  if (kind !== undefined) {
    if ((kind !== 'tree' && kind !== 'blob') || !ref) {
      throw new GitHubSourceError(
        'Paste the repository URL, or a folder of it (…/tree/<branch>/<folder>)',
      );
    }
    if (!REF.test(ref) || ref.includes('..'))
      throw new GitHubSourceError('That branch name is not allowed');
    pinnedRef = ref;
    const path = kind === 'blob' && rest.at(-1) === 'SKILL.md' ? rest.slice(0, -1) : rest;
    if (kind === 'blob' && path.length === rest.length) {
      throw new GitHubSourceError('Link to the Skill’s folder, or to its SKILL.md');
    }
    folder = path.join('/');
  }
  const chosen = subpath?.trim() ? subpath.trim().replace(/^\/+|\/+$/g, '') : folder;
  if (
    chosen !== '' &&
    chosen.split('/').some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p))
  ) {
    throw new GitHubSourceError('The folder must be a relative path without ".."');
  }
  return { owner, repo, ref: pinnedRef, subpath: chosen };
}

/** A link to the Skill's folder at a commit, for people to read. */
export function githubFolderUrl(repository: string, commit: string, subpath: string): string {
  return `https://github.com/${repository}/tree/${commit}${subpath ? `/${subpath}` : ''}`;
}

/**
 * GETs `url` with redirects followed by hand: every hop must be `https` on one of
 * `FETCH_HOSTS`, without credentials or a port. The body is read up to `maxBytes`.
 */
export async function fetchFromGitHub(
  fetcher: HttpFetch,
  input: string,
  options: { maxBytes: number; accept: string; timeoutMs?: number },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let url = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowed(url);
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        redirect: 'manual',
        signal,
        headers: { accept: options.accept, 'user-agent': 'Vorasaan (Agent Skills)' },
      });
    } catch (error) {
      const reason =
        (error as Error).name === 'TimeoutError' ? 'it timed out' : 'it is unreachable';
      throw new GitHubSourceError(`Could not fetch from ${url.host}: ${reason}`);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (!location)
        throw new GitHubSourceError(`${url.host} answered a redirect without a target`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubSourceError(
        response.status === 404
          ? 'GitHub has no such repository, branch or commit (or it is private)'
          : `GitHub answered HTTP ${response.status}`,
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel();
      throw new GitHubTooLargeError(`The download is larger than ${options.maxBytes} bytes`);
    }
    return {
      bytes: await readCapped(response, options.maxBytes),
      contentType: response.headers.get('content-type') ?? '',
    };
  }
  throw new GitHubSourceError('Too many redirects');
}

function assertAllowed(url: URL) {
  if (url.protocol !== 'https:') {
    throw new GitHubSourceError(`Refused to fetch ${url.protocol}// (only https)`);
  }
  if (!FETCH_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password) {
    throw new GitHubSourceError(`Refused to fetch from ${url.host}: only GitHub is allowed`);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new GitHubTooLargeError(`The download is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The commit `target.ref` (or the default branch) points at now, from GitHub's API. */
export async function resolveCommit(fetcher: HttpFetch, target: GitHubTarget): Promise<string> {
  const ref = target.ref ?? 'HEAD';
  if (SHA.test(ref)) return ref;
  const { bytes } = await fetchFromGitHub(
    fetcher,
    `https://api.github.com/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(ref)}`,
    { maxBytes: 1_024, accept: 'application/vnd.github.sha' },
  );
  const sha = new TextDecoder().decode(bytes).trim();
  if (!SHA.test(sha)) throw new GitHubSourceError('GitHub did not name a commit for that ref');
  return sha;
}

/** The repository's zip at `commit`, from GitHub's download host. */
export async function downloadZip(
  fetcher: HttpFetch,
  target: GitHubTarget,
  commit: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!SHA.test(commit)) throw new GitHubSourceError('Not a commit');
  const { bytes } = await fetchFromGitHub(
    fetcher,
    `https://codeload.github.com/${target.owner}/${target.repo}/zip/${commit}`,
    { maxBytes, accept: 'application/zip' },
  );
  return bytes;
}
