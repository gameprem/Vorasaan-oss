// `bun run bundle:check` (after `next build`): fails if a main route's first-load JS grew past
// its budget in bundle-budget.json plus the margin. `--update` records the current sizes of
// the budgeted routes instead, for a change that makes them smaller or knowingly larger.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Budget, firstLoadKb, overBudget } from '../lib/bundle-budget';

const WEB = join(import.meta.dir, '..');
const BUDGET = join(WEB, 'bundle-budget.json');

const budget = JSON.parse(readFileSync(BUDGET, 'utf8')) as Budget;
const measured = firstLoadKb(WEB);

if (process.argv.includes('--update')) {
  const routes = Object.fromEntries(
    Object.keys(budget.routes).map((route) => [route, measured[route] ?? budget.routes[route]]),
  );
  writeFileSync(BUDGET, `${JSON.stringify({ ...budget, routes }, null, 2)}\n`);
  console.log(`Recorded ${Object.keys(routes).length} routes in bundle-budget.json.`);
  process.exit(0);
}

console.log('First-load JS (gzip), now / budget:');
for (const [route, kb] of Object.entries(budget.routes)) {
  console.log(`  ${route.padEnd(28)} ${String(measured[route] ?? '-').padStart(6)} / ${kb} kB`);
}
const over = overBudget(budget, measured);
if (over.length) {
  console.error(
    `\nOver budget (margin ${budget.margin * 100}%):\n  ${over.join('\n  ')}\n` +
      'Load the new weight lazily, or run `bun run bundle:check --update` if it is worth it.',
  );
  process.exit(1);
}
console.log(`\nAll ${Object.keys(budget.routes).length} routes within budget.`);
