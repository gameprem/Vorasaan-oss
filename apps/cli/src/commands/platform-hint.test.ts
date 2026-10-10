import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, platformHint, platformHintFor, suggestPlatforms } from './platform-hint.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BACK_END = { id: id(1), name: 'Back-End' };
const FLUTTER = { id: id(2), name: 'Flutter' };

describe('suggesting a Platform from the changed files (ticket 0052)', () => {
  test('lib/**/*.dart points to Flutter, named as the Feature names it', () => {
    const files = ['lib/main.dart', 'lib/orders/order_card.dart', 'README.md'];
    expect(suggestPlatforms(files, [BACK_END, { id: id(3), name: 'flutter app' }])).toEqual([
      { name: 'flutter app', known: true, files: ['lib/main.dart', 'lib/orders/order_card.dart'] },
    ]);
    // Without a matching target, the rule's own name.
    expect(suggestPlatforms(files)).toEqual([
      { name: 'Flutter', known: false, files: ['lib/main.dart', 'lib/orders/order_card.dart'] },
    ]);
  });

  test('a directory wins over the extension; the most files come first', () => {
    const files = [
      'apps/server/src/payments.ts',
      'apps/server/src/orders.ts',
      'apps/web/components/order-card.tsx',
      'ios/Runner/AppDelegate.swift',
      'scripts/build.ts',
    ];
    expect(suggestPlatforms(files).map((s) => [s.name, s.files.length])).toEqual([
      ['Back-End', 2],
      ['Front-End', 1],
      ['Mobile', 1],
    ]);
  });

  test('the hint is one line, says it is a hint, and notes a Platform the Feature does not target', () => {
    expect(platformHint([], true)).toBeUndefined();
    const flutter = suggestPlatforms(['lib/main.dart'], [FLUTTER]);
    expect(platformHint(flutter, true)).toBe(
      'Hint: 1 changed file (lib/main.dart) suggests the Flutter Platform. If this is about Flutter, name it in the title so Coverage counts it there.',
    );
    const untargeted = suggestPlatforms(['lib/a.dart', 'lib/b.dart'], [BACK_END]);
    expect(platformHint(untargeted, true)).toBe(
      "Hint: 2 changed files (lib/a.dart, …) suggest the Flutter Platform. If this is about Flutter, name it in the title so Coverage counts it there. This Feature doesn't target Flutter.",
    );
  });
});

describe('the changed files of a repository', () => {
  let dir: string;

  async function git(...args: string[]) {
    const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
    expect(await proc.exited).toBe(0);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vorasaan-platform-hint-'));
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.test');
    await git('config', 'user.name', 'Test');
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    await writeFile(join(dir, '.gitignore'), 'build/\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test('changed and untracked files count, ignored ones do not', async () => {
    await writeFile(join(dir, 'lib', 'main.dart'), 'void main() { run(); }\n');
    await writeFile(join(dir, 'lib', 'retry.dart'), 'void retry() {}\n');
    await mkdir(join(dir, 'build'));
    await writeFile(join(dir, 'build', 'out.dart'), '\n');
    expect((await changedFiles(dir)).sort()).toEqual(['lib/main.dart', 'lib/retry.dart']);
  });

  test("the raise hint reads the Feature's targets, and never fails the raise", async () => {
    await writeFile(join(dir, 'lib', 'retry.dart'), 'void retry() {}\n');
    const api = { feature: async () => ({ platforms: [BACK_END, FLUTTER] }) };
    expect(await platformHintFor(api, id(9), dir)).toContain('suggests the Flutter Platform');
    const failing = { feature: () => Promise.reject(new Error('offline')) };
    expect(await platformHintFor(failing, id(9), dir)).toContain('Flutter');
    // Nothing changed: no hint.
    await git('add', '.');
    await git('commit', '-q', '-m', 'retry');
    expect(await platformHintFor(api, id(9), dir)).toBeUndefined();
  });
});
