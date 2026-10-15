// A Turbopack loader (next.config.ts) that keeps only the locales the app speaks in React
// Aria's string tables. Each component's `intlStrings.mjs` imports its strings in 34 locales;
// the kit is only ever in English (en-GB, which falls back to en-US) or Thai (th-TH, which
// React Aria has no strings for yet, so it falls back to en-US too), so the others are dropped
// from the client bundle. React Aria documents this as its optimize-locales-plugin, which runs
// only under webpack, Vite, Rollup or esbuild.

/** The locales kept: what `KIT_LOCALE` (components/ui/provider.tsx) can fall back to. */
export const KEPT_LOCALES = ['en-US', 'th-TH'];

const IMPORT = /^import (\S+) from "[^"]*\/([a-z]{2}-[A-Z]{2})\.mjs";\n/gm;

/**
 * `source` (an `intlStrings.mjs`) without the imports and entries of locales not in `keep`.
 * Returns it unchanged if it doesn't look like a string table.
 */
export function keepLocales(source, keep = KEPT_LOCALES) {
  const dropped = [];
  const out = source.replace(IMPORT, (line, name, locale) => {
    if (keep.includes(locale)) return line;
    dropped.push({ name, locale });
    return '';
  });
  return dropped.reduce(
    (code, { name, locale }) =>
      code.replace(`"${locale}": ${name},`, '').replace(`"${locale}": ${name}`, ''),
    out,
  );
}

export default function reactAriaLocalesLoader(source) {
  return keepLocales(source);
}
