import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VorasaanApi } from '../api.ts';
import { runScan, type ScanOptions } from './scan.ts';

const PROJECT = '00000000-0000-4000-8000-000000000201';

describe('vorasaan scan', () => {
  let server: ReturnType<typeof Bun.serve>;
  let received: { path: string; body: Record<string, unknown> }[];
  let dir: string;
  let printed: string[];
  let asked: string[];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({
          path: new URL(req.url).pathname,
          body: (await req.json()) as Record<string, unknown>,
        });
        return Response.json({ id: 'a1', title: 'Repo Scan: shop' }, { status: 201 });
      },
    });
  });
  afterAll(() => server.stop());

  beforeEach(async () => {
    received = [];
    printed = [];
    asked = [];
    dir = await mkdtemp(join(tmpdir(), 'vorasaan-scan-cmd-'));
    await writeFile(join(dir, 'README.md'), '# Shop\n\nSells things.\n');
    await writeFile(join(dir, '.env'), 'SECRET=1\n');
    return () => rm(dir, { recursive: true, force: true });
  });

  function run(options: Partial<ScanOptions>, answer: boolean) {
    return runScan(
      { projectId: PROJECT, dir, dryRun: false, yes: false, ...options },
      {
        api: async () =>
          new VorasaanApi({ baseUrl: server.url.origin, credentials: { token: 'vsp_t' } }),
        confirm: async (message) => {
          asked.push(message);
          return answer;
        },
        print: (text) => printed.push(text),
      },
    );
  }

  test('shows the summary and sends it only after confirming', async () => {
    const sent = await run({}, true);
    expect(asked).toHaveLength(1);
    expect(printed.join('\n')).toContain('## READMEs');
    expect(printed.join('\n')).toContain('Sells things.');
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe(`/projects/${PROJECT}/repo-scans`);
    expect(received[0]?.body.repoName).toBeString();
    expect(received[0]?.body.markdown).toContain('Sells things.');
    expect(JSON.stringify(received[0]?.body)).not.toContain('SECRET');
    expect(sent?.title).toBe('Repo Scan: shop');
  });

  test('declining the prompt sends nothing', async () => {
    expect(await run({}, false)).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(received).toHaveLength(0);
    expect(printed.join('\n')).toContain('Nothing was sent');
  });

  test('--dry-run prints the summary, asks nothing and sends nothing', async () => {
    let apiLoaded = false;
    await runScan(
      { projectId: PROJECT, dir, dryRun: true, yes: true },
      {
        api: async () => {
          apiLoaded = true;
          throw new Error('no network in a dry run');
        },
        confirm: async () => {
          throw new Error('no prompt in a dry run');
        },
        print: (text) => printed.push(text),
      },
    );
    expect(apiLoaded).toBe(false);
    expect(received).toHaveLength(0);
    expect(printed.join('\n')).toContain('Sells things.');
    expect(printed.join('\n')).toContain('Dry run: nothing was sent');
  });

  test('--yes sends without asking, still printing the summary', async () => {
    await run({ yes: true }, false);
    expect(asked).toHaveLength(0);
    expect(printed.join('\n')).toContain('Sells things.');
    expect(received).toHaveLength(1);
  });
});
