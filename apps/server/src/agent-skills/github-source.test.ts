import { describe, expect, test } from 'bun:test';
import { FakeGitHub } from '../test/fake-github.ts';
import {
  downloadZip,
  fetchFromGitHub,
  GitHubSourceError,
  GitHubTooLargeError,
  parseGitHubUrl,
  resolveCommit,
} from './github-source.ts';

describe('GitHub URLs of Agent Skills (ticket 0078)', () => {
  test('a repository, a folder at a ref, or a SKILL.md link', () => {
    expect(parseGitHubUrl('https://github.com/acme/skills')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: null,
      subpath: '',
    });
    expect(parseGitHubUrl('https://github.com/acme/skills.git')).toMatchObject({ repo: 'skills' });
    expect(parseGitHubUrl('https://github.com/acme/skills/tree/v2/design/flow')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: 'v2',
      subpath: 'design/flow',
    });
    expect(parseGitHubUrl('https://github.com/acme/skills/blob/main/flow/SKILL.md')).toMatchObject({
      ref: 'main',
      subpath: 'flow',
    });
    // A folder given apart from the URL names the folder.
    expect(parseGitHubUrl('https://github.com/acme/skills', '/flow/')).toMatchObject({
      subpath: 'flow',
    });
  });

  test('refuses plain http, other hosts, credentials, ports and traversal', () => {
    const refused = [
      'http://github.com/acme/skills',
      'https://gitlab.com/acme/skills',
      'https://github.com.evil.example/acme/skills',
      'https://user:pass@github.com/acme/skills',
      'https://github.com:8443/acme/skills',
      'https://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'https://github.com/acme',
      'https://github.com/acme/skills/issues/1',
      'not a url',
    ];
    for (const url of refused) expect(() => parseGitHubUrl(url)).toThrow(GitHubSourceError);
    expect(() => parseGitHubUrl('https://github.com/acme/skills', '../etc')).toThrow(
      GitHubSourceError,
    );
    expect(() => parseGitHubUrl('https://github.com/acme/skills/tree/main/../../x')).toThrow(
      GitHubSourceError,
    );
  });
});

describe('fetching from GitHub', () => {
  test('resolves a ref to its commit and downloads the zip at that commit', async () => {
    const github = new FakeGitHub();
    const sha = github.publish('acme', 'skills', [{ path: 'SKILL.md', data: 'x' }]);
    const target = parseGitHubUrl('https://github.com/acme/skills');
    expect(await resolveCommit(github.fetch, target)).toBe(sha);
    const zip = await downloadZip(github.fetch, target, sha, 1_000_000);
    expect(zip.byteLength).toBeGreaterThan(0);
    expect(github.requests).toEqual([
      'https://api.github.com/repos/acme/skills/commits/HEAD',
      `https://codeload.github.com/acme/skills/zip/${sha}`,
    ]);
  });

  test('never follows a redirect off GitHub, nor to plain http', async () => {
    const github = new FakeGitHub();
    const sha = github.publish('acme', 'skills', [{ path: 'SKILL.md', data: 'x' }]);
    const zipUrl = `https://codeload.github.com/acme/skills/zip/${sha}`;
    const target = parseGitHubUrl('https://github.com/acme/skills');
    for (const location of [
      'https://evil.example/skill.zip',
      'http://codeload.github.com/acme/skills/zip/x',
      'https://127.0.0.1/admin',
      'https://codeload.github.com:444/x',
    ]) {
      github.reset();
      github.publish('acme', 'skills', [{ path: 'SKILL.md', data: 'x' }]);
      github.redirect(zipUrl, location);
      await expect(downloadZip(github.fetch, target, sha, 1_000_000)).rejects.toThrow(
        /Refused to fetch/,
      );
      // Only the GitHub URL itself was ever requested.
      expect(github.requests).toEqual([zipUrl]);
    }
  });

  test('follows a redirect between GitHub hosts', async () => {
    const github = new FakeGitHub();
    const sha = github.publish('acme', 'skills', [{ path: 'SKILL.md', data: 'x' }]);
    github.redirect(
      'https://api.github.com/x',
      `https://codeload.github.com/acme/skills/zip/${sha}`,
    );
    const { bytes } = await fetchFromGitHub(github.fetch, 'https://api.github.com/x', {
      maxBytes: 1_000_000,
      accept: '*/*',
    });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test('caps the download, and says when GitHub has no such repository', async () => {
    const github = new FakeGitHub();
    const sha = github.publish('acme', 'skills', [{ path: 'SKILL.md', data: 'x'.repeat(5_000) }]);
    const target = parseGitHubUrl('https://github.com/acme/skills');
    await expect(downloadZip(github.fetch, target, sha, 100)).rejects.toThrow(GitHubTooLargeError);
    await expect(
      resolveCommit(github.fetch, parseGitHubUrl('https://github.com/acme/missing')),
    ).rejects.toThrow(/no such repository/);
  });
});
