import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E } from './env';
import { expect, pim, test, unique } from './fixtures';

/** Seeds a Project with decided and overdue requests (see seed-decision-stats.ts). */
function seedProject(name: string): string {
  return execFileSync(
    'bun',
    [fileURLToPath(new URL('./seed-decision-stats.ts', import.meta.url)), name],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  ).trim();
}

test('the Project page shows the median lead time and what is overdue now', async ({ as }) => {
  const projectId = seedProject(unique('Refunds'));

  const page = await as(pim);
  await page.goto(`/projects/${projectId}`);
  const panel = page.getByRole('region', { name: 'Decision speed' });
  await expect(panel).toBeVisible();

  // Lead times of 1h, 2h and 4h: the median is 2h.
  await expect(panel.getByRole('definition').filter({ hasText: /^2h$/ })).toBeVisible();
  await expect(panel.getByText('3 decided · Blockers 3h · Questions 1h')).toBeVisible();
  const overdue = panel.getByRole('term').filter({ hasText: 'Overdue now' });
  await expect(overdue.locator('xpath=following-sibling::dd[1]')).toHaveText('2');
  await expect(panel.getByTestId('lead-time-trend')).toBeVisible();

  const list = panel.getByRole('list', { name: 'Overdue requests' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('link', { name: 'Overdue: refund limit' })).toBeVisible();
  await expect(list.getByText(/^overdue \d+[mhd]$/).first()).toBeVisible();
});
