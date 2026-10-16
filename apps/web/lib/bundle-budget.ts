import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// The bundle budget: each main route's first-load client JavaScript (gzip), read from
// `next build`'s own report (.next/diagnostics/route-bundle-stats.json), must stay within
// the size recorded in bundle-budget.json plus a margin. `bun run bundle:check` checks it
// after a build (CI does); `--update` records the current sizes.

/** One route of `.next/diagnostics/route-bundle-stats.json`. */
export type RouteBundleStats = {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths: string[];
};

export type Budget = {
  /** How far over its recorded size a route may grow, as a share (0.05 is 5%). */
  margin: number;
  /** First-load JS per route, gzip, in kB (1024 bytes). */
  routes: Record<string, number>;
};

/** First-load JS per route, gzip, in kB, from the build's report under `webDir`. */
export function firstLoadKb(webDir: string): Record<string, number> {
  const stats = JSON.parse(
    readFileSync(join(webDir, '.next/diagnostics/route-bundle-stats.json'), 'utf8'),
  ) as RouteBundleStats[];
  const gzipped = new Map<string, number>();
  const size = (file: string) => {
    let bytes = gzipped.get(file);
    if (bytes === undefined) {
      bytes = gzipSync(readFileSync(join(webDir, file))).length;
      gzipped.set(file, bytes);
    }
    return bytes;
  };
  return Object.fromEntries(
    stats.map((s) => [
      s.route,
      Math.round((s.firstLoadChunkPaths.reduce((sum, f) => sum + size(f), 0) / 1024) * 10) / 10,
    ]),
  );
}

/** Every budgeted route that is over its size plus the margin, or missing from the build. */
export function overBudget(budget: Budget, measured: Record<string, number>): string[] {
  return Object.entries(budget.routes).flatMap(([route, kb]) => {
    const now = measured[route];
    if (now === undefined) return [`${route}: not in the build`];
    const limit = Math.round(kb * (1 + budget.margin) * 10) / 10;
    return now > limit ? [`${route}: ${now} kB, over its ${kb} kB budget (limit ${limit} kB)`] : [];
  });
}
