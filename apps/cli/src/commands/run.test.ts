import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureSummaryView, FeatureView, HandOffView } from '@vorasaan/shared';
import { VorasaanApi } from '../api.ts';
import { ConfigError } from '../config.ts';
import { UsageError } from './raise-options.ts';
import { type RunDeps, type RunOptions, runRun } from './run.ts';

const FEATURE = '00000000-0000-4000-8000-000000000004';
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const BACK_END = '00000000-0000-4000-8000-000000000021';
const FRONT_END = '00000000-0000-4000-8000-000000000022';
const TOKEN = 'vsp_test_token_1234567890';

const summary = (id: string, title: string, projectId = PROJECT): FeatureSummaryView => ({
  id,
  title,
  teamId: '00000000-0000-4000-8000-000000000003',
  teamName: 'Checkout',
  projectId,
  projectName: 'Mobile Banking',
  myRoles: ['BACKEND'],
});

const feature: FeatureView = {
  ...summary(FEATURE, 'Async checkout'),
  jiraIssueKey: 'MB-42',
  jiraIssueUrl: null,
  openBlockers: 0,
  platforms: [
    { id: BACK_END, name: 'Back-End' },
    { id: FRONT_END, name: 'Front-End' },
  ],
};

function handOffView(overrides: Partial<HandOffView> = {}): HandOffView {
  return {
    featureId: FEATURE,
    title: 'Async checkout',
    slug: 'async-checkout',
    projectName: 'Mobile Banking',
    teamName: 'Checkout',
    jiraIssueKey: 'MB-42',
    jiraIssueUrl: null,
    specVersion: 2,
    platform: { key: BACK_END, name: 'Back-End', chosenBy: 'CHANGED_FILES' },
    platforms: [
      { key: BACK_END, name: 'Back-End' },
      { key: FRONT_END, name: 'Front-End' },
      { key: 'qa', name: 'QA' },
    ],
    designDoc: { name: 'Back-End', version: 1, specVersion: 2, stale: false },
    designDocNote: null,
    tokens: { budget: 24_000, used: 1_234 },
    markdown: `---\nvorasaan-feature: ${FEATURE}\n---\n# Hand-off: Feature "Async checkout"\n\nSandbox key ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`,
    ...overrides,
  };
}

/** The fake Vorasaan server: what it answers, and the requests it saw. */
let server: ReturnType<typeof Bun.serve>;
let seen: { path: string; search: URLSearchParams; auth: string | null }[];
let features: FeatureSummaryView[];
let answer: HandOffView;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        search: url.searchParams,
        auth: req.headers.get('authorization'),
      });
      if (url.pathname === '/features') return Response.json(features);
      if (url.pathname === `/features/${FEATURE}`) return Response.json(feature);
      if (url.pathname === `/features/${FEATURE}/hand-off`) return Response.json(answer);
      if (url.pathname === `/features/${OTHER}/hand-off`) {
        return Response.json(
          { statusCode: 400, message: 'This Feature doesn\'t target a Platform "Flutter"' },
          { status: 400 },
        );
      }
      return Response.json({ statusCode: 404, message: 'Feature not found' }, { status: 404 });
    },
  });
});
afterAll(() => server.stop());

let root: string;
let printed: string[];
let spawned: { command: string[]; cwd: string; env: Record<string, string | undefined> }[];
let picked: FeatureSummaryView[][];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vorasaan-run-'));
  await mkdir(join(root, '.git'));
  seen = [];
  printed = [];
  spawned = [];
  picked = [];
  features = [summary(FEATURE, 'Async checkout'), summary(OTHER, 'Refunds')];
  answer = handOffView();
});
afterEach(() => rm(root, { recursive: true, force: true }));

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    api: new VorasaanApi({ baseUrl: server.url.toString(), credentials: { token: TOKEN } }),
    repo: { root, cwd: root, projectId: PROJECT },
    secrets: [TOKEN],
    pickFeature: async (list) => {
      picked.push(list);
      return list[0]?.id;
    },
    print: (text) => printed.push(text),
    interactive: true,
    which: (bin) => `/usr/local/bin/${bin}`,
    spawn: async (command, options) => {
      spawned.push({ command, ...options });
      return 7;
    },
    env: { PATH: '/usr/bin', HOME: '/home/dev', VORASAAN_TOKEN: TOKEN, VORASAAN_USER: 'u' },
    changedFiles: async () => ['server/payments.go', 'server/queue.go', 'web/Order.tsx'],
    ...overrides,
  };
}

const run = (options: Partial<RunOptions> = {}, overrides: Partial<RunDeps> = {}) =>
  runRun({ launch: true, ...options }, deps(overrides));

const handOffRequest = () => seen.find((s) => s.path.endsWith('/hand-off'));
const written = () => readFile(join(root, '.vorasaan', 'specs', 'async-checkout.md'), 'utf8');

describe('vorasaan run (ticket 0079)', () => {
  test('writes the Hand-off to .vorasaan/specs/<feature>.md and starts the assistant on it', async () => {
    const result = await run({ feature: FEATURE, ai: 'claude' });
    expect(result).toMatchObject({ exitCode: 7, launched: true });
    expect(result.path).toBe(join(root, '.vorasaan', 'specs', 'async-checkout.md'));
    const text = await written();
    expect(text).toContain('# Hand-off: Feature "Async checkout"');
    // A credential the server let through is redacted again before writing.
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toContain('[redacted: looks like a credential]');

    // The changed files' Platforms went as a hint, best first; the token only as a header.
    const request = handOffRequest();
    expect(request?.search.get('hint')).toBe('Back-End,Front-End');
    expect(request?.auth).toBe(`Bearer ${TOKEN}`);

    // The assistant runs in the repository, told only the path, without the credentials.
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call?.cwd).toBe(root);
    expect(call?.command[0]).toBe('/usr/local/bin/claude');
    expect(call?.command[1]).toStartWith('Read .vorasaan/specs/async-checkout.md first');
    expect(call?.command.join(' ')).not.toContain('Hand-off: Feature');
    expect(call?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev' });

    expect(printed[0]).toBe(
      'Wrote .vorasaan/specs/async-checkout.md: "Async checkout", Spec v2, about 1,234 of 24,000 tokens.',
    );
    expect(printed).toContain(
      'Design Doc: Back-End v1, follows Spec v2 (from your Team Roles and the changed files).',
    );
    expect(printed).toContain("Another Platform's Design Doc: --platform Front-End | QA");
    expect(printed.at(-1)).toBe(`Starting claude in ${root}…`);
  });

  test('--platform and --budget go to the server, and no hint is computed', async () => {
    let read = false;
    await run(
      { feature: FEATURE, platform: 'qa', budget: 8000 },
      {
        changedFiles: async () => {
          read = true;
          return [];
        },
      },
    );
    const request = handOffRequest();
    expect(request?.search.get('platform')).toBe('qa');
    expect(request?.search.get('budget')).toBe('8000');
    expect(request?.search.has('hint')).toBe(false);
    expect(read).toBe(false);
  });

  test('without --ai, with --no-launch, without a terminal or on PATH, it prints the command', async () => {
    await run({ feature: FEATURE });
    expect(printed.at(-1)).toStartWith(
      "Hand it to your coding assistant, for example: claude 'Read .vorasaan/specs/async-checkout.md first",
    );
    await run({ feature: FEATURE, ai: 'gemini', launch: false });
    expect(printed.at(-1)).toStartWith("Start gemini with: gemini --prompt-interactive 'Read ");
    await run({ feature: FEATURE, ai: 'codex' }, { interactive: false });
    expect(printed.at(-1)).toStartWith("Start codex with: codex 'Read ");
    await run({ feature: FEATURE, ai: 'claude' }, { which: () => null });
    expect(printed.at(-1)).toStartWith("claude isn't on your PATH. Install it, then run: claude '");
    expect(spawned).toHaveLength(0);
  });

  test('the Feature: by id, by title or file name, the only one in scope, or picked', async () => {
    await run({ feature: 'ASYNC CHECKOUT' });
    expect(handOffRequest()?.path).toBe(`/features/${FEATURE}/hand-off`);
    seen = [];
    await run({ feature: 'async-checkout' });
    expect(handOffRequest()?.path).toBe(`/features/${FEATURE}/hand-off`);

    // Scoped to the bound Project: only Async checkout is in it, so no picker.
    features = [summary(FEATURE, 'Async checkout'), summary(OTHER, 'Refunds', OTHER)];
    seen = [];
    await run();
    expect(picked).toHaveLength(0);
    expect(printed).toContain('Feature: Async checkout');

    // Several: the picker, unless nobody is at the terminal.
    features = [summary(FEATURE, 'Async checkout'), summary(OTHER, 'Refunds')];
    await run();
    expect(picked.at(-1)?.map((f) => f.title)).toEqual(['Async checkout', 'Refunds']);
    await expect(run({}, { interactive: false })).rejects.toThrow('Pass --feature');
    await expect(run({}, { pickFeature: async () => undefined })).resolves.toMatchObject({
      launched: false,
    });
    expect(printed.at(-1)).toBe('Cancelled. Nothing was written.');

    await expect(run({ feature: 'Payments v3' })).rejects.toThrow(UsageError);
    features = [summary(FEATURE, 'Async checkout'), summary(OTHER, 'Async  Checkout', OTHER)];
    await expect(run({ feature: 'async checkout' }, { repo: { root, cwd: root } })).rejects.toThrow(
      'matches several Features',
    );
  });

  test("the server's errors come through, and nothing is written", async () => {
    await expect(run({ feature: OTHER, platform: 'Flutter' })).rejects.toThrow(
      'doesn\'t target a Platform "Flutter"',
    );
    expect(await readdir(root)).toEqual(['.git']);
  });

  test('the access token never reaches the file: redacted, or nothing is written', async () => {
    answer = handOffView({ markdown: `---\nvorasaan-feature: ${FEATURE}\n---\nkey ${TOKEN}\n` });
    await run({ feature: FEATURE });
    expect(await written()).not.toContain(TOKEN);

    // A credential of no known shape that the CLI holds: refused before writing.
    const odd = 'plain-secret-of-no-known-shape';
    answer = handOffView({ markdown: `---\nvorasaan-feature: ${FEATURE}\n---\nkey ${odd}\n` });
    await expect(run({ feature: FEATURE }, { secrets: [odd] })).rejects.toThrow(
      'contains your Vorasaan access token',
    );
    expect(await written()).not.toContain(odd);
  });

  test('suggests the .gitignore line in a git repository that would commit the file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'vorasaan-run-git-'));
    try {
      expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: repo }).exitCode).toBe(0);
      await run({ feature: FEATURE }, { repo: { root: repo, cwd: repo } });
      expect(printed).toContain(
        'Tip: add ".vorasaan/specs/" to .gitignore. A Hand-off is a snapshot: run `vorasaan run` again for the latest.',
      );
      printed = [];
      await writeFile(join(repo, '.gitignore'), '.vorasaan/specs/\n');
      await run({ feature: FEATURE }, { repo: { root: repo, cwd: repo } });
      expect(printed.some((line) => line.startsWith('Tip:'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('refuses a symlinked .vorasaan/specs that would write outside the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vorasaan-run-outside-'));
    try {
      await mkdir(join(root, '.vorasaan'));
      await symlink(outside, join(root, '.vorasaan', 'specs'));
      await expect(run({ feature: FEATURE })).rejects.toThrow(ConfigError);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
