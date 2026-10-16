import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Budget, overBudget } from './bundle-budget';

describe('bundle budget', () => {
  const budget: Budget = { margin: 0.05, routes: { '/': 100, '/inbox': 120 } };

  test('passes within the margin', () => {
    expect(overBudget(budget, { '/': 105, '/inbox': 90, '/other': 999 })).toEqual([]);
  });

  test('names a route over its budget plus the margin', () => {
    expect(overBudget(budget, { '/': 105.1, '/inbox': 120 })).toEqual([
      '/: 105.1 kB, over its 100 kB budget (limit 105 kB)',
    ]);
  });

  test('names a budgeted route the build no longer has', () => {
    expect(overBudget(budget, { '/': 90 })).toEqual(['/inbox: not in the build']);
  });

  test('the recorded budget is well formed', () => {
    const recorded = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'bundle-budget.json'), 'utf8'),
    ) as Budget;
    expect(recorded.margin).toBeGreaterThan(0);
    expect(recorded.margin).toBeLessThanOrEqual(0.1);
    expect(Object.keys(recorded.routes).length).toBeGreaterThan(0);
    for (const kb of Object.values(recorded.routes)) expect(kb).toBeGreaterThan(0);
  });
});
