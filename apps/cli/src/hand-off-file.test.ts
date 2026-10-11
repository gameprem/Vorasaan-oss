import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handOffSlug, redactCredentials } from '@vorasaan/shared';
import {
  ASSISTANTS,
  assistantCommand,
  assistantEnv,
  handOffPrompt,
  isAssistantName,
  shellQuote,
} from './assistants.ts';
import { ConfigError } from './config.ts';
import { writeHandOff } from './hand-off-file.ts';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const file = (id: string, body = 'Spec') => `---\nvorasaan-feature: ${id}\n---\n${body}\n`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vorasaan-handoff-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const specs = () => join(root, '.vorasaan', 'specs');

describe('Hand-off file names (ticket 0079)', () => {
  test('letters and digits of any script, joined by "-"; never a dot or a slash', () => {
    expect(handOffSlug('Async checkout', A)).toBe('async-checkout');
    expect(handOffSlug('ชำระเงิน แบบ Async (v2)', A)).toBe('ชำระเงิน-แบบ-async-v2');
    expect(handOffSlug('../../etc/passwd', A)).toBe('etc-passwd');
    expect(handOffSlug('..\\..\\Windows', A)).toBe('windows');
    expect(handOffSlug('🙂 ...', A)).toBe('feature-00000000');
    expect(handOffSlug('word '.repeat(40), A).length).toBeLessThanOrEqual(60);
  });

  test('a credential is redacted, the rest kept', () => {
    expect(redactCredentials('key AKIAABCDEFGHIJKLMNOP and text')).toBe(
      'key [redacted: looks like a credential] and text',
    );
    expect(redactCredentials('db postgres://app:hunter22@db:5432/x')).toBe(
      'db postgres://app:[redacted: looks like a credential]@db:5432/x',
    );
    expect(redactCredentials('The session token expires after 30 minutes.')).toBe(
      'The session token expires after 30 minutes.',
    );
  });
});

describe('writeHandOff (ticket 0079)', () => {
  test('writes .vorasaan/specs/<slug>.md and replaces it on the next run', async () => {
    const first = await writeHandOff(root, 'async-checkout', A, file(A, 'one'));
    expect(first.relativePath).toBe('.vorasaan/specs/async-checkout.md');
    await writeHandOff(root, 'async-checkout', A, file(A, 'two'));
    expect(await readFile(first.path, 'utf8')).toBe(file(A, 'two'));
    // No temporary file is left behind.
    expect(await readdir(specs())).toEqual(['async-checkout.md']);
  });

  test("another Feature's file of the same name is kept: the id goes in the name", async () => {
    await writeHandOff(root, 'checkout', A, file(A));
    const second = await writeHandOff(root, 'checkout', B, file(B));
    expect(second.relativePath).toBe('.vorasaan/specs/checkout-00000000.md');
    expect(await readFile(join(specs(), 'checkout.md'), 'utf8')).toBe(file(A));
    // A file someone wrote by hand is never overwritten either.
    await writeFile(join(specs(), 'notes.md'), 'mine');
    expect((await writeHandOff(root, 'notes', A, file(A))).relativePath).toBe(
      '.vorasaan/specs/notes-00000000.md',
    );
    expect(await readFile(join(specs(), 'notes.md'), 'utf8')).toBe('mine');
  });

  test('refuses a name that could leave the folder', async () => {
    for (const slug of ['../escape', 'a/b', 'a\\b', '.hidden', '', 'a.md', 'a--b']) {
      await expect(writeHandOff(root, slug, A, file(A))).rejects.toThrow(ConfigError);
    }
    expect(await readdir(root)).toEqual([]);
  });

  test('refuses a symlinked .vorasaan, and replaces a planted file symlink without following it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vorasaan-outside-'));
    try {
      await symlink(outside, join(root, '.vorasaan'));
      await expect(writeHandOff(root, 'x', A, file(A))).rejects.toThrow('is a symlink');
      await rm(join(root, '.vorasaan'));

      await mkdir(specs(), { recursive: true });
      const victim = join(outside, 'victim.md');
      await writeFile(victim, 'keep');
      await symlink(victim, join(specs(), 'x.md'));
      await expect(writeHandOff(root, 'x', A, file(A))).rejects.toThrow('is a symlink');
      expect(await readFile(victim, 'utf8')).toBe('keep');
      expect((await lstat(join(specs(), 'x.md'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('coding assistants (ticket 0079)', () => {
  test('each starts with the path only, and the printed command is quoted for a shell', () => {
    const prompt = handOffPrompt('.vorasaan/specs/async-checkout.md');
    expect(ASSISTANTS.claude.args(prompt)).toEqual([prompt]);
    expect(ASSISTANTS.gemini.args(prompt)).toEqual(['--prompt-interactive', prompt]);
    expect(assistantCommand('codex', "it's")).toBe(`codex 'it'\\''s'`);
    expect(shellQuote('.vorasaan/specs/a.md')).toBe('.vorasaan/specs/a.md');
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
    expect(isAssistantName('claude')).toBe(true);
    expect(isAssistantName('toString')).toBe(false);
  });

  test("the assistant's environment never carries Vorasaan credentials", () => {
    expect(
      assistantEnv({
        PATH: '/bin',
        VORASAAN_TOKEN: 'vsp_x',
        VORASAAN_USER: 'u',
        VORASAAN_API_URL: 'h',
      }),
    ).toEqual({ PATH: '/bin', VORASAAN_API_URL: 'h' });
  });
});
