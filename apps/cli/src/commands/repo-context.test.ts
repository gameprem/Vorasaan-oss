import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepoContext, describeWithContext, FILE_MAX_BYTES } from './repo-context.ts';

let dir: string;

async function git(...args: string[]) {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
  expect(await proc.exited).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vorasaan-context-'));
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(dir, 'app.ts'), 'export const retries = 1;\n');
  await writeFile(join(dir, '.env'), 'API_KEY=one\n');
  await git('add', '-f', 'app.ts', '.env');
  await git('commit', '-q', '-m', 'init');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('repository context for a Decision Request', () => {
  test('the diff covers changed files but never secret-looking ones', async () => {
    await writeFile(join(dir, 'app.ts'), 'export const retries = 3;\n');
    await writeFile(join(dir, '.env'), 'API_KEY=two\n');
    const context = await collectRepoContext(dir, { diff: true });
    expect(context.markdown).toContain('**Current diff**');
    expect(context.markdown).toContain('+export const retries = 3;');
    expect(context.markdown).not.toContain('API_KEY');
    expect(context.skipped).toEqual(['.env (secret-looking)']);
  });

  test('chosen files: inside the repo only, no symlinks out, capped, redacted, fenced safely', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vorasaan-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'private\n');
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
      await mkdir(join(dir, 'docs'));
      await writeFile(join(dir, 'docs', 'big.md'), `${'x'.repeat(100)}\n`.repeat(200));
      await writeFile(
        join(dir, 'docs', 'fence.md'),
        'before\n````\ninjected\n````\npassword = "hunter2"\n',
      );
      const context = await collectRepoContext(
        dir,
        { files: ['big.md', 'fence.md', '../../etc/passwd', 'link.txt', '.env', 'missing.ts'] },
        join(dir, 'docs'),
      );
      expect(context.markdown).toContain('**`docs/big.md`**');
      expect(Buffer.byteLength(context.markdown)).toBeLessThan(FILE_MAX_BYTES * 2 + 500);
      expect(context.markdown).toContain('`````\nbefore\n````\ninjected');
      expect(context.markdown).not.toContain('hunter2');
      expect(context.markdown).not.toContain('private');
      expect(context.skipped).toEqual([
        'docs/big.md truncated to 8 KB',
        '../../etc/passwd (outside the repository)',
        'docs/link.txt (not a readable file in the repository)',
        'docs/.env (secret-looking or ignored)',
        'missing.ts (at most 5 files)',
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('the description keeps the Raiser text first; no context leaves it unchanged', async () => {
    const empty = await collectRepoContext(dir, { diff: true });
    expect(empty.markdown).toBe('');
    expect(empty.skipped).toEqual(['diff (no changes)']);
    expect(describeWithContext('Text', empty)).toBe('Text');
    expect(describeWithContext('Text ', { markdown: 'CTX', skipped: [] })).toBe(
      'Text\n\n---\n\nCTX',
    );
  });
});
