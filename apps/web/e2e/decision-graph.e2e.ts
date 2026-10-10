import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { E2E } from './env';
import { expect, expectNoViolations, pim, THEMES, test, unique } from './fixtures';

/** Seeds a Feature with Spec Versions and Decision Requests (see seed-decision-graph.ts). */
function seedFeature(title: string, mode?: 'empty'): string {
  return execFileSync(
    'bun',
    [
      fileURLToPath(new URL('./seed-decision-graph.ts', import.meta.url)),
      title,
      ...(mode ? [mode] : []),
    ],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  ).trim();
}

const graphOf = (page: Page) => page.getByRole('region', { name: 'Decision Graph' });
const version = (page: Page, n: number) =>
  graphOf(page).getByRole('link', { name: new RegExp(`^Spec v${n}\\.`) });
const request = (page: Page, title: string) =>
  graphOf(page).getByRole('link', { name: new RegExp(`^(Blocker|Question): ${title}`) });

test('the Decision Graph shows each request branching off and merging back into the Spec', async ({
  as,
}) => {
  const featureId = seedFeature(unique('Instant payouts'));
  const page = await as(pim);
  await page.goto(`/features/${featureId}?tab=graph`);

  const graph = graphOf(page);
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('link', { name: /^Spec v\d+\./ })).toHaveCount(4);
  await expect(graph.getByRole('link', { name: /^(Blocker|Question): / })).toHaveCount(5);
  await expect(version(page, 4)).toHaveAccessibleName('Spec v4. Reverted to v1, approved by Pim.');
  await expect(request(page, 'Webhook or polling\\?')).toHaveAccessibleName(
    'Blocker: Webhook or polling?. Decided and merged into the Spec. v1 → v2.',
  );
  await expect(request(page, 'Keep the old receipt\\?')).toHaveAccessibleName(
    'Question: Keep the old receipt?. Decided without a Spec change. From v3, not merged.',
  );
  await expect(request(page, 'Which retry budget\\?')).toHaveAccessibleName(
    /^Blocker: Which retry budget\?\. Waiting for a decision\. From v4, not merged\. due in [23]h\.$/,
  );

  // Open branches are dashed; merged and closed ones are not.
  const branches = page.getByTestId('decision-graph-branch');
  for (const state of ['WAITING', 'NEEDS_INFO', 'AWAITING_APPROVAL']) {
    await expect(
      branches.and(page.locator(`[data-state="${state}"]`)).locator('path'),
    ).toHaveAttribute('stroke-dasharray', '5 4');
  }
  await expect(
    branches.and(page.locator('[data-state="MERGED"]')).locator('path'),
  ).not.toHaveAttribute('stroke-dasharray', /./);
  await expect(page.getByTestId('redraft-mark')).toHaveCount(1);
  await expect(graph.getByText(/^waiting · due in [23]h$/)).toBeVisible();

  // Hover shows the details: who, what was chosen, where, and the versions.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await request(page, 'Webhook or polling\\?').hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1500 });
  }).toPass();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Raised by Beam');
  await expect(tooltip).toContainText('Decider: Pim');
  await expect(tooltip).toContainText('Decision: B. Wait for the webhook');
  await expect(tooltip).toContainText('Decided in Slack');
  await expect(tooltip).toContainText('v1 → v2');
  await expect(tooltip).toContainText('1 Redraft');

  // Light and dark both pass axe.
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoViolations(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // The keyboard: one Tab stop, the arrows move along and between lanes, Enter opens.
  await version(page, 4).focus();
  await expect(version(page, 4)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowLeft');
  await expect(version(page, 3)).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('Spec v3');
  await page.keyboard.press('Home');
  await expect(version(page, 1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(request(page, 'Webhook or polling\\?')).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('Decided in Slack');
  await page.keyboard.press('ArrowUp');
  await expect(version(page, 1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Webhook or polling?' })).toBeVisible();

  // A click on a Spec Version opens its diff in the Version history.
  await page.goBack();
  await version(page, 2).click();
  await expect(page).toHaveURL(new RegExp(`/features/${featureId}\\?tab=history&diff=2$`));
  await expect(page.locator('figure').filter({ hasText: 'v1 → v2' })).toBeVisible();
});

test('at 375px the graph scrolls sideways inside itself, never the page', async ({ as }) => {
  const featureId = seedFeature(unique('Narrow payouts'));
  const page = await as(pim);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/features/${featureId}?tab=graph`);
  const scroller = page.getByTestId('decision-graph-scroll');
  await expect(scroller).toBeVisible();

  const sizes = await scroller.evaluate((el) => ({
    inner: el.scrollWidth,
    box: el.clientWidth,
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(sizes.inner).toBeGreaterThan(sizes.box);
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);

  // The newest version is reachable: scrolling the graph brings it into view.
  await version(page, 4).focus();
  await expect(version(page, 4)).toBeInViewport();
});

test('a Feature without Decision Requests shows an empty state', async ({ as }) => {
  const featureId = seedFeature(unique('Quiet payouts'), 'empty');
  const page = await as(pim);
  await page.goto(`/features/${featureId}?tab=graph`);
  await expect(page.getByText('No Decision Requests yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Raise a Decision Request' }).last()).toBeVisible();
  await expectNoViolations(page);
});
