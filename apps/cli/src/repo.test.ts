import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featuresInScope } from './commands/raise-flow.ts';
import { bindingApplies, currentRepo, readRepoBinding } from './repo.ts';
import { features, PROJECT_A } from './tui/fixtures.ts';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'vorasaan-repo-')));
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, '.vorasaan'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const bind = (value: unknown) =>
  writeFile(join(dir, '.vorasaan', 'config.json'), JSON.stringify(value));

describe('repo binding', () => {
  test('reads only the known keys; a token in the file is ignored, never used', async () => {
    await bind({ projectId: PROJECT_A, token: 'vsp_leaked' });
    expect(await readRepoBinding(dir)).toEqual({ projectId: PROJECT_A });
  });

  test('applies only to the server it names', () => {
    expect(bindingApplies({ projectId: PROJECT_A }, 'http://a.test')).toBe(true);
    expect(
      bindingApplies({ projectId: PROJECT_A, apiUrl: 'http://a.test/' }, 'http://a.test'),
    ).toBe(true);
    expect(
      bindingApplies({ projectId: PROJECT_A, apiUrl: 'http://evil.test' }, 'http://a.test'),
    ).toBe(false);
  });

  test('currentRepo scopes to the bound Project, or explains why it does not', async () => {
    await mkdir(join(dir, 'src'));
    expect(await currentRepo(join(dir, 'src'), 'http://a.test')).toEqual({
      root: dir,
      cwd: join(dir, 'src'),
    });
    await bind({ projectId: PROJECT_A });
    expect((await currentRepo(dir, 'http://a.test')).projectId).toBe(PROJECT_A);

    await bind({ projectId: PROJECT_A, apiUrl: 'http://other.test' });
    const other = await currentRepo(dir, 'http://a.test');
    expect(other.projectId).toBeUndefined();
    expect(other.notice).toContain('http://other.test');

    await bind({ projectId: 'nope' });
    expect((await currentRepo(dir, 'http://a.test')).notice).toContain('no valid "projectId"');
  });

  test('the Feature list is scoped to the bound Project', async () => {
    const api = { listFeatures: async () => features };
    expect((await featuresInScope(api, PROJECT_A)).map((f) => f.title)).toEqual(['Async checkout']);
    expect(await featuresInScope(api)).toHaveLength(2);
  });
});
