import { createHash } from 'node:crypto';
import type { HttpFetch } from '../agent-skills/github-source.ts';
import { buildZip, type ZipFile } from './zip.ts';

type Repo = { refs: Map<string, string>; zips: Map<string, Uint8Array> };

/**
 * A fake GitHub for Agent Skills (ticket 0078): the commits API (`api.github.com`) and the
 * zip downloads (`codeload.github.com`), served in process. Every request is recorded, and a
 * request to any other URL fails the test, so nothing ever reaches the network.
 */
export class FakeGitHub {
  readonly requests: string[] = [];
  private readonly repos = new Map<string, Repo>();
  private readonly redirects = new Map<string, string>();

  /**
   * Publishes files as a new commit of `ref` (default "main", also the default branch), the
   * repository zip holding them under its "<repo>-<sha>/" folder as GitHub's does.
   */
  publish(owner: string, repo: string, files: ZipFile[], ref = 'main'): string {
    const key = `${owner}/${repo}`;
    const entry = this.repos.get(key) ?? { refs: new Map(), zips: new Map() };
    this.repos.set(key, entry);
    const sha = createHash('sha1')
      .update(
        `${key}@${ref}#${entry.zips.size}:${JSON.stringify(files.map((f) => [f.path, String(f.data)]))}`,
      )
      .digest('hex');
    const top = `${repo}-${sha}/`;
    entry.zips.set(
      sha,
      buildZip([{ path: top }, ...files.map((f) => ({ ...f, path: `${top}${f.path}` }))]),
    );
    entry.refs.set(ref, sha);
    if (ref === 'main') entry.refs.set('HEAD', sha);
    return sha;
  }

  /** Answers `url` with a redirect to `location` instead. */
  redirect(url: string, location: string): void {
    this.redirects.set(url, location);
  }

  reset(): void {
    this.requests.length = 0;
    this.repos.clear();
    this.redirects.clear();
  }

  readonly fetch: HttpFetch = async (url) => {
    this.requests.push(url);
    const location = this.redirects.get(url);
    if (location) return new Response(null, { status: 302, headers: { location } });
    const parsed = new URL(url);
    const commits = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(parsed.pathname);
    if (parsed.host === 'api.github.com' && commits) {
      const sha = this.repos
        .get(`${commits[1]}/${commits[2]}`)
        ?.refs.get(decodeURIComponent(commits[3] ?? ''));
      return sha ? new Response(sha) : new Response('Not Found', { status: 404 });
    }
    const zip = /^\/([^/]+)\/([^/]+)\/zip\/([0-9a-f]{40})$/.exec(parsed.pathname);
    if (parsed.host === 'codeload.github.com' && zip) {
      const bytes = this.repos.get(`${zip[1]}/${zip[2]}`)?.zips.get(zip[3] ?? '');
      return bytes
        ? new Response(bytes, { headers: { 'content-type': 'application/zip' } })
        : new Response('Not Found', { status: 404 });
    }
    throw new Error(`The fake GitHub was asked for ${url}, which it doesn't serve`);
  };
}
