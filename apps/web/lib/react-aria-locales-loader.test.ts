import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { KIT_LOCALE } from '@/components/ui/provider';
import { KEPT_LOCALES, keepLocales } from './react-aria-locales-loader.js';

const TABLE = `import $a from "../intl/menu/ar-AE.mjs";
import $e from "../intl/menu/en-US.mjs";
import $t from "../intl/menu/th-TH.mjs";
import $z from "../intl/menu/zh-TW.mjs";


var $exports = {};
$exports = {
    "ar-AE": $a,
    "en-US": $e,
    "th-TH": $t,
    "zh-TW": $z
};


export {$exports as default};
`;

describe('React Aria locales loader', () => {
  test('keeps only the kept locales, imports and entries both', () => {
    const out = keepLocales(TABLE);
    expect(out).toContain('import $e from "../intl/menu/en-US.mjs";');
    expect(out).toContain('import $t from "../intl/menu/th-TH.mjs";');
    expect(out).toContain('"en-US": $e,');
    expect(out).toContain('"th-TH": $t,');
    expect(out).not.toContain('ar-AE');
    expect(out).not.toContain('zh-TW');
    expect(out).not.toContain('$a');
    expect(out).not.toContain('$z');
  });

  test('every kit locale finds its strings: en-GB through en-US, th-TH as itself', () => {
    const languages = new Set(KEPT_LOCALES.map((l) => l.split('-')[0]));
    for (const locale of Object.values(KIT_LOCALE)) {
      expect(languages.has(locale.split('-')[0] ?? '')).toBe(true);
    }
    expect(KEPT_LOCALES).toContain('en-US'); // React Aria's last resort
  });

  test("still matches React Aria's own string tables", () => {
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve('react-aria-components'));
    const source = readFileSync(join(dist, '..', 'private', 'intlStrings.mjs'), 'utf8');
    const out = keepLocales(source);
    expect(source).toContain('"ar-AE"');
    expect(out).not.toContain('"ar-AE"');
    expect(out).toContain('"en-US"');
    // React Aria has no Thai strings yet (Thai falls back to en-US); kept if it gets some.
    const kept = KEPT_LOCALES.filter((l) => source.includes(`"${l}"`));
    expect(out.match(/^import /gm)).toHaveLength(kept.length);
  });
});
