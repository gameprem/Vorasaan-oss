import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E } from './env';
import { beam, expect, expectNoViolations, pim, SEED, THEMES, test, unique } from './fixtures';

const featurePath = `/features/${SEED.featureId}`;

test('the Sidebar reaches every page, and Ctrl+K starts a new Conversation', async ({ as }) => {
  const page = await as(pim);
  await page.goto('/inbox');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });

  await sidebar.getByRole('link', { name: 'My Requests' }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole('heading', { level: 1, name: 'My Requests' })).toBeVisible();

  await sidebar.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // A Project opens its latest Conversation, or a new one there, and expands to its Features.
  await sidebar.getByRole('link', { name: 'Mobile Banking', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/conversations/(new\\?project=${SEED.projectId}|[0-9a-f-]{36})$`),
  );
  const features = sidebar.getByRole('button', { name: 'Hide the Features of Mobile Banking' });
  await expect(features).toHaveAttribute('aria-expanded', 'true');
  await sidebar.getByRole('link', { name: /^Async checkout/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/conversations/(new\\?feature=${SEED.featureId}|[0-9a-f-]{36})$`),
  );
  await expect(sidebar.getByRole('link', { name: /^Async checkout/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The Feature's own page is a link away, in the header.
  await page
    .getByRole('navigation', { name: 'Where this Conversation belongs' })
    .getByRole('link', { name: 'Async checkout' })
    .click();
  await expect(page).toHaveURL(new RegExp(`${featurePath}$`));

  await sidebar.getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  await page.keyboard.press('Control+k');
  await expect(page).toHaveURL(/\/conversations\/new$/);
  await expect(sidebar.getByRole('link', { name: 'New conversation' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('Settings opens as a modal over the page, and Back and Esc return to it', async ({ as }) => {
  const page = await as(pim);
  await page.goto(featurePath);
  // Scroll to a fixed offset rather than with the wheel: wheel events can land late and scroll
  // twice. Retry until the page is tall enough to scroll; scrollTo is idempotent.
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.scrollTo(0, 500);
        return window.scrollY;
      }),
    )
    .toBeGreaterThan(0);
  const scrollY = await page.evaluate(() => window.scrollY);

  const settingsButton = page.getByRole('link', { name: 'Settings', exact: true });
  await settingsButton.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(dialog.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();

  // Each section has its own URL; the page underneath stays.
  await dialog.getByRole('link', { name: 'AI models' }).click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(dialog.getByRole('heading', { name: 'AI models' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'AI models' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Focus stays inside the modal.
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  // Back returns to the exact page, scrolled where it was, with focus on Settings.
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${featurePath}$`));
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(settingsButton).toBeFocused();

  // Esc does the same.
  await settingsButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${featurePath}$`));
  await expect(settingsButton).toBeFocused();
});

test('a /settings/ai link or reload opens the modal on AI models', async ({ as }) => {
  const page = await as(pim);
  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'AI models' })).toBeVisible();
  await page.reload();
  await expect(dialog.getByRole('heading', { name: 'AI models' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'AI models' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // There is no page underneath, so Back goes to the default view.
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(dialog).toHaveCount(0);
});

test('at 375px the Sidebar is a drawer and the page does not scroll sideways', async ({ as }) => {
  const page = await as(pim);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(featurePath);

  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar).toBeHidden();
  const noSideScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noSideScroll()).toBe(true);

  await page.getByRole('button', { name: 'Open the Sidebar' }).click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Close the Sidebar' })).toBeFocused();
  expect(await noSideScroll()).toBe(true);

  // Picking a page closes the drawer.
  await sidebar.getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(sidebar).toBeHidden();
  expect(await noSideScroll()).toBe(true);

  // Esc closes it too, back to the menu button.
  await page.getByRole('button', { name: 'Open the Sidebar' }).click();
  await expect(sidebar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open the Sidebar' })).toBeFocused();
});

test('the Sidebar passes axe in light and dark: expanded, collapsed and as a drawer', async ({
  as,
  request,
}) => {
  // A Feature with an open Blocker (its "1 Blocker" label) and a Question sent to Pim (the
  // Inbox count), so every state colour of the Sidebar shows.
  const featureId = execFileSync(
    'bun',
    [
      fileURLToPath(new URL('./seed-decision-graph.ts', import.meta.url)),
      unique('Sidebar payouts'),
      'empty',
    ],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  ).trim();
  const asBeam = { 'x-vorasaan-user': beam.id };
  const raise = async (kind: 'BLOCKER' | 'QUESTION', recipients: unknown) => {
    const raised = await request.post(`${E2E.apiUrl}/decision-requests`, {
      headers: asBeam,
      data: { featureId, kind, title: unique('Sidebar request'), description: 'For the Sidebar.' },
    });
    expect(raised.status()).toBe(201);
    const { id } = (await raised.json()) as { id: string };
    const sent = await request.post(`${E2E.apiUrl}/decision-requests/${id}/submit`, {
      headers: asBeam,
      data: { deciderRole: 'PO', recipients },
    });
    expect(sent.ok()).toBe(true);
    return id;
  };
  const raised = [await raise('BLOCKER', 'ALL'), await raise('QUESTION', { userId: pim.id })];

  try {
    const page = await as(pim);
    await page.goto(`/features/${featureId}`);
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar.getByRole('link', { name: /^Inbox/ }).locator('.count')).toBeVisible();
    await expect(
      sidebar
        .locator('.muted')
        .filter({ hasText: /Blocker/ })
        .first(),
    ).toBeVisible();
    const check = async () => {
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme });
        await expectNoViolations(page, 'aside.side');
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };
    await check();

    // Collapsed to a rail of icons.
    await sidebar.getByRole('button', { name: 'Collapse the Sidebar' }).click();
    await expect(sidebar.getByRole('button', { name: 'Expand the Sidebar' })).toBeVisible();
    await check();
    await sidebar.getByRole('button', { name: 'Expand the Sidebar' }).click();

    // A drawer on a phone, over the whole page.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Open the Sidebar' }).click();
    await expect(sidebar).toBeVisible();
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      await expectNoViolations(page);
    }
  } finally {
    for (const id of raised) {
      await request.post(`${E2E.apiUrl}/decision-requests/${id}/withdraw`, { headers: asBeam });
    }
  }
});
