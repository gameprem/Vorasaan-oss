import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { E2E } from './env';
import { expectNoViolations, pim, SEED, THEMES, test, unique } from './fixtures';

// Every page passes axe (WCAG 2.1 A and AA) in light and dark, Sidebar included (ticket 0077):
// colour contrast is checked against the real backgrounds, which the tokens alone can't show.

/** A Feature with Spec Versions and Decision Requests in every state (seed-decision-graph.ts). */
function seedFeature(title: string): string {
  return execFileSync(
    'bun',
    [fileURLToPath(new URL('./seed-decision-graph.ts', import.meta.url)), title],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  ).trim();
}

async function checkPages(page: Page, paths: string[]) {
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      await test.step(`${path} (${theme})`, () => expectNoViolations(page));
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
}

const FEATURE_TABS = [
  'spec',
  'design-docs',
  'attachments',
  'team',
  'history',
  'decisions',
  'graph',
];
const PROJECT_TABS = [
  'brief',
  'history',
  'attachments',
  'grilling',
  'guidelines',
  'suggestions',
  'platforms',
  'coverage',
];
const SETTINGS = [
  'members',
  'organization',
  'ai',
  'ai/usage',
  'ai/prompts',
  'agent-skills',
  'chat-apps',
  'delegations',
  'feature-guidelines',
  'notifications',
  'response-windows',
  'platforms',
  'tokens',
];

test('the signed-out login page passes axe', async ({ page }) => {
  await checkPages(page, ['/login']);
});

test('the Inbox, My Requests, Projects, a Team and a new Conversation pass axe', async ({ as }) => {
  const page = await as(pim);
  await checkPages(page, [
    '/inbox',
    '/requests',
    '/projects',
    `/teams/${SEED.teamId}`,
    '/conversations/new',
  ]);
});

test("every tab of a Project's page passes axe", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as(pim);
  await checkPages(
    page,
    PROJECT_TABS.map((tab) => `/projects/${SEED.projectId}?tab=${tab}`),
  );
});

test("every tab of a Feature's page, its diff and raising a request pass axe", async ({ as }) => {
  test.setTimeout(240_000);
  const featureId = seedFeature(unique('Axe payouts'));
  const page = await as(pim);
  await checkPages(page, [
    ...FEATURE_TABS.map((tab) => `/features/${featureId}?tab=${tab}`),
    `/features/${featureId}?tab=history&diff=2`,
    `/features/${featureId}/raise`,
  ]);
});

test('a Decision Request in every state passes axe', async ({ as }) => {
  test.setTimeout(180_000);
  const featureId = seedFeature(unique('Axe requests'));
  const page = await as(pim);
  await page.goto(`/features/${featureId}?tab=graph`);
  const requests = await page
    .getByRole('region', { name: 'Decision Graph' })
    .locator('a[href^="/requests/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute('href') ?? ''))]);
  await checkPages(page, requests);
});

test('every Settings section passes axe', async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as(pim);
  await checkPages(
    page,
    SETTINGS.map((section) => `/settings/${section}`),
  );
  await page.goto('/settings/ai/prompts');
  const prompt = await page
    .locator('a[href^="/settings/ai/prompts/"]')
    .first()
    .getAttribute('href');
  if (prompt) await checkPages(page, [prompt]);
});
