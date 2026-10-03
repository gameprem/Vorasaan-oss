import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ADR 0016, ticket 0077: forms use the UI kit in components/ui, never a browser-native
// <select>, checkbox, radio, date or time input. The kit itself may wrap native inputs.

const WEB = join(import.meta.dir, '..');
const SKIP = new Set(['node_modules', '.next', 'e2e', 'test-results', 'playwright-report']);
const KIT = join(WEB, 'components', 'ui');

const NATIVE = [
  { what: 'a native <select>', pattern: /<select(\s|>|\/|$)/ },
  {
    what: 'a native checkbox, radio, date or time input',
    pattern: /type=\{?\s*["'`](checkbox|radio|date|time|datetime-local)["'`]/,
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (SKIP.has(entry) || path === KIT) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx|jsx)$/.test(entry) ? [path] : [];
  });
}

/** Every native control outside the kit, as "file:line: what". */
export function nativeControls(files: string[] = sources(WEB)): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        NATIVE.filter((n) => n.pattern.test(line)).map(
          (n) => `${relative(WEB, file)}:${i + 1}: ${n.what}`,
        ),
      ),
  );
}

describe('native form controls', () => {
  test('the check finds them', () => {
    expect(NATIVE[0]?.pattern.test('<select name="role">')).toBe(true);
    expect(NATIVE[1]?.pattern.test('<input type="datetime-local" />')).toBe(true);
    expect(NATIVE[1]?.pattern.test("<input type={'checkbox'} />")).toBe(true);
    expect(NATIVE[1]?.pattern.test('<input type="email" />')).toBe(false);
    expect(NATIVE[1]?.pattern.test('<input type="hidden" />')).toBe(false);
  });

  test('none are left in apps/web outside components/ui', () => {
    expect(nativeControls()).toEqual([]);
  });
});
