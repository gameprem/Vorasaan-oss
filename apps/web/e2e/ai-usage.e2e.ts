import type { APIRequestContext, Page } from '@playwright/test';
import type { AiSettingsView, NotificationList } from '@vorasaan/shared';
import { E2E } from './env';
import { beam, expect, expectNoViolations, pim, SEED, THEMES, test, unique } from './fixtures';

// Settings → AI usage (ticket 0075): an Admin reads what the AI used, sets a price on an
// Approved Model and sees a cost, sets a monthly budget and is told once it is passed. The
// charts have a text summary and a table view, work with the keyboard, and are axe-clean in
// light and dark. A Member gets neither the page nor the API. The price and the budget are
// cleared again, and the Notification read, so no other spec sees them.

const asPim = { 'x-vorasaan-user': pim.id };
const asBeam = { 'x-vorasaan-user': beam.id };

/** An Approved Model (the default) the AI calls run on; the fake answers whatever the model. */
async function approvedModel(request: APIRequestContext) {
  const listed = await request.get(`${E2E.apiUrl}/settings/ai`, { headers: asPim });
  const { models } = (await listed.json()) as AiSettingsView;
  const found = models.find((m) => m.isDefault);
  if (found) return found;
  const provider = await request.post(`${E2E.apiUrl}/settings/ai/providers`, {
    headers: asPim,
    data: { kind: 'ANTHROPIC', name: 'Fake provider', apiKey: 'sk-e2e-not-a-real-key' },
  });
  expect(provider.status()).toBe(201);
  const providerId = ((await provider.json()) as { id: string }).id;
  const model = await request.post(`${E2E.apiUrl}/settings/ai/models`, {
    headers: asPim,
    data: { providerId, modelId: 'fake-best', displayName: 'Best' },
  });
  expect(model.status()).toBe(201);
  return (await model.json()) as AiSettingsView['models'][number];
}

/** An AI call: Beam raises a Blocker, and the fake drafts its Choices (one Receipt). */
async function aiCall(request: APIRequestContext) {
  const raised = await request.post(`${E2E.apiUrl}/decision-requests`, {
    headers: asBeam,
    data: {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: unique('AI usage e2e'),
      description: 'Only polling is available.',
    },
  });
  expect(raised.status()).toBe(201);
}

/** Settings has hydrated: it moves the focus to Back once, which would steal ours. */
const settled = (page: Page) => expect(page.getByRole('button', { name: 'Back' })).toBeFocused();

test('an Admin sees the AI usage, sets a price and a budget, and is told the budget is passed', async ({
  as,
  request,
}) => {
  const model = await approvedModel(request);
  await aiCall(request);

  const page = await as(pim);
  await page.goto('/settings/ai/usage');
  await settled(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'AI usage', level: 2 })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'AI usage' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const headlines = dialog.getByTestId('usage-headlines');
  await expect(headlines.getByText(/^\d+ calls?/)).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'By task' })).toContainText('Choices');

  // A price on the model: the cost appears.
  const price = dialog.getByRole('form', { name: `Price of ${model.displayName}` });
  await price.getByLabel('Input, $ per million').fill('3');
  await price.getByLabel('Output, $ per million').fill('15');
  await price.getByRole('button', { name: 'Save price' }).click();
  await expect(dialog.getByText(`Price of ${model.displayName} saved.`)).toBeVisible();
  await page.reload();
  const cost = page
    .getByTestId('usage-headlines')
    .getByRole('term')
    .filter({ hasText: 'Estimated cost' })
    .locator('xpath=following-sibling::dd[1]');
  await expect(cost).toHaveText(/^\$\d/);

  // A budget far below what was spent: past 100% at once, so one Notification to the Admins.
  const budget = page.getByRole('region', { name: 'Monthly budget' });
  await budget.getByLabel('Budget per month (US$)').fill('0.0001');
  await budget.getByRole('button', { name: 'Save budget' }).click();
  await expect(budget.getByRole('status')).toHaveText('Budget saved.');
  await expect(budget.getByTestId('budget-spent')).toContainText(/of \$0\.0001 spent/);
  const notifications = await request.get(`${E2E.apiUrl}/notifications`, { headers: asPim });
  const { notifications: list } = (await notifications.json()) as NotificationList;
  expect(list.filter((n) => n.type === 'AI_BUDGET_REACHED')).toHaveLength(1);
  const forBeam = await request.get(`${E2E.apiUrl}/notifications`, { headers: asBeam });
  expect(
    ((await forBeam.json()) as NotificationList).notifications.some((n) =>
      n.type.startsWith('AI_BUDGET'),
    ),
  ).toBe(false);

  // Leave nothing behind for other specs.
  await budget.getByRole('button', { name: 'Remove budget' }).click();
  await expect(budget.getByRole('status')).toHaveText('Budget removed.');
  const cleared = await request.patch(`${E2E.apiUrl}/settings/ai/models/${model.id}`, {
    headers: asPim,
    data: { prices: null },
  });
  expect(cleared.status()).toBe(200);
  await request.post(`${E2E.apiUrl}/notifications/read-all`, { headers: asPim });
});

for (const theme of THEMES) {
  test(`the charts have a summary and a table view, work by keyboard, axe-clean in ${theme}`, async ({
    as,
    request,
  }) => {
    await approvedModel(request);
    await aiCall(request);
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/ai/usage');
    await settled(page);
    await expectNoViolations(page);

    // Tokens per day: one Tab stop; the arrows move between days, the readout follows.
    const daily = page.getByRole('region', { name: 'Tokens per day' });
    await expect(daily.getByText(/^Over 30 days the AI read [\d,]+ tokens/)).toBeVisible();
    const days = daily.getByRole('toolbar', { name: 'Tokens per day' });
    await expect(days.getByRole('button')).toHaveCount(30);
    const current = days.locator('button[tabindex="0"]');
    await current.focus();
    await page.keyboard.press('End');
    const today = days.getByRole('button').last();
    await expect(today).toBeFocused();
    await expect(today).toHaveAttribute('tabindex', '0');
    const label = await today.getAttribute('aria-label');
    expect(label).toMatch(/^\d{1,2} \w{3}: [\d,]+ tokens in, [\d,]+ out, [\d,]+ calls?/);
    await expect(daily.getByTestId('chart-readout')).toHaveText(label ?? '');
    await page.keyboard.press('ArrowLeft');
    await expect(days.getByRole('button').nth(28)).toBeFocused();
    await expect(daily.getByTestId('chart-readout')).not.toHaveText(label ?? '');
    // Tab leaves the chart in one step.
    await page.keyboard.press('Shift+Tab');
    await expect(days.getByRole('button').nth(28)).not.toBeFocused();

    // The table view, by keyboard: the same days as rows.
    const table = daily
      .getByRole('radio', { name: 'Table' })
      .or(daily.getByRole('button', { name: 'Table' }));
    await table.focus();
    await page.keyboard.press('Enter');
    const rows = daily.getByRole('table', { name: 'Tokens per day' }).getByRole('row');
    await expect(rows).toHaveCount(31);
    await expect(rows.last()).toContainText(/\d{1,2} \w{3}/);
    await expectNoViolations(page);

    // By task: each bar is named by its task first.
    const tasks = page.getByRole('region', { name: 'By task' });
    await expect(tasks.getByText(/used the most tokens/)).toBeVisible();
    const choices = tasks
      .getByRole('toolbar', { name: 'Tokens by task' })
      .getByRole('button', { name: /^Choices: / });
    await expect(choices).toBeVisible();
    await tasks
      .getByRole('toolbar', { name: 'Tokens by task' })
      .locator('button[tabindex="0"]')
      .focus();
    await page.keyboard.press('Home');
    await expect(
      tasks.getByRole('toolbar', { name: 'Tokens by task' }).getByRole('button').first(),
    ).toBeFocused();
    await tasks
      .getByRole('button', { name: 'Table' })
      .or(tasks.getByRole('radio', { name: 'Table' }))
      .click();
    await expect(tasks.getByRole('table', { name: 'By task' })).toContainText('Choices');
    await expectNoViolations(page);
  });
}

test('a Member gets no AI usage, and the API refuses them', async ({ as, request }) => {
  const page = await as(beam);
  await page.goto('/settings/ai/usage');
  await expect(page.getByText('Only an Organization Admin can see the AI usage.')).toBeVisible();
  expect((await request.get(`${E2E.apiUrl}/settings/ai/usage`, { headers: asBeam })).status()).toBe(
    403,
  );
  const budget = await request.put(`${E2E.apiUrl}/settings/ai/usage/budget`, {
    headers: asBeam,
    data: { monthlyUsd: 5 },
  });
  expect(budget.status()).toBe(403);
});
