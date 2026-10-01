import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectView } from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import { ConfigError } from '../config.ts';
import { readRepoBinding } from '../repo.ts';
import { type InitOptions, runInit } from './init.ts';
import type { ScanOptions } from './scan.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const projects: ProjectView[] = [
  { id: A, name: 'Mobile Banking', jiraKey: 'MB', teams: [] },
  { id: B, name: 'Web Shop', jiraKey: null, teams: [] },
];

let dir: string;
let printed: string[];
let asked: string[];
let scanned: ScanOptions[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vorasaan-init-'));
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  printed = [];
  asked = [];
  scanned = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function init(
  options: Partial<InitOptions> = {},
  { pick = A, answer = true }: { pick?: string | 'cancel'; answer?: boolean } = {},
) {
  const api = { listProjects: async () => projects, baseUrl: 'http://api.test' };
  return runInit(
    { dir, scan: false, dryRun: false, yes: false, ...options },
    {
      api: async () => api as unknown as VorasaanApi,
      pickProject: async () => (pick === 'cancel' ? undefined : pick),
      confirm: async (message) => {
        asked.push(message);
        return answer;
      },
      print: (text) => printed.push(text),
      scan: async (scanOptions) => {
        scanned.push(scanOptions);
      },
    },
  );
}

const configFile = () => join(dir, '.vorasaan', 'config.json');

describe('vorasaan init', () => {
  test('writes { projectId } at the repository root, even from a subdirectory', async () => {
    await init({ dir: join(dir, 'src', 'deep') });
    expect(JSON.parse(await readFile(configFile(), 'utf8'))).toEqual({ projectId: A });
    expect(printed.join('\n')).toContain('"Mobile Banking"');
    expect(asked).toEqual([]);
  });

  test('never writes a token or any other secret; only projectId and apiUrl', async () => {
    await init({ apiUrl: 'http://vorasaan.test' });
    const text = await readFile(configFile(), 'utf8');
    expect(JSON.parse(text)).toEqual({ projectId: A, apiUrl: 'http://vorasaan.test' });
    expect(text).not.toContain('token');
    expect(text).not.toContain('vsp_');
  });

  test('an existing binding is only replaced after a confirm', async () => {
    await init({ projectId: A });
    await init({ projectId: B }, { answer: false });
    expect(asked).toEqual([
      '.vorasaan/config.json binds this repository to "Mobile Banking". Replace it with "Web Shop"?',
    ]);
    expect(await readRepoBinding(dir)).toEqual({ projectId: A });

    await init({ projectId: B }, { answer: true });
    expect(await readRepoBinding(dir)).toEqual({ projectId: B });
  });

  test('--yes replaces without asking; the same binding is left alone', async () => {
    await init({ projectId: A });
    await init({ projectId: A });
    expect(printed.at(-1)).toContain('already binds');
    await init({ projectId: B, yes: true });
    expect(asked).toEqual([]);
    expect(await readRepoBinding(dir)).toEqual({ projectId: B });
  });

  test('cancelling the picker writes nothing', async () => {
    await init({}, { pick: 'cancel' });
    expect(await Bun.file(configFile()).exists()).toBe(false);
  });

  test('rejects an unknown Project id', async () => {
    await expect(init({ projectId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toThrow(
      'No Project',
    );
  });

  test('--scan runs the Repo Scan for the bound Project at the repo root', async () => {
    await init({ dir: join(dir, 'src'), scan: true, dryRun: true });
    expect(scanned).toEqual([{ projectId: A, dir, dryRun: true, yes: false }]);
  });

  test('--scan with a kept binding scans the kept Project', async () => {
    await init({ projectId: A });
    await init({ projectId: B, scan: true }, { answer: false });
    expect(scanned[0]?.projectId).toBe(A);
  });

  test('refuses a .vorasaan symlink that points outside the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vorasaan-outside-'));
    try {
      await symlink(outside, join(dir, '.vorasaan'));
      await expect(init({ projectId: A })).rejects.toBeInstanceOf(ConfigError);
      expect(await Bun.file(join(outside, 'config.json')).exists()).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('an invalid existing file is reported and can be replaced', async () => {
    await mkdir(join(dir, '.vorasaan'));
    await writeFile(configFile(), '{ nope');
    await init({ projectId: B });
    expect(printed[0]).toContain('not valid JSON');
    expect(await readRepoBinding(dir)).toEqual({ projectId: B });
  });
});
