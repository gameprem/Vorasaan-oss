import type { APIRequestContext, Locator } from '@playwright/test';
import { E2E } from './env';
import { beam, chooseOption, expect, expectNoViolations, POPOVER, pim, test } from './fixtures';

// Settings → AI prompts (ticket 0071): an Admin writes a Prompt Version of the Choices
// prompt, compares it with the default, runs evals on both (the server's AI is the fake)
// and compares the runs, approves it, then rolls back to the default. A Member gets none
// of it.

const asPim = { 'x-vorasaan-user': pim.id };
const asBeam = { 'x-vorasaan-user': beam.id };
const LINE = 'Keep every Choice under forty words.';

/** Picks an option, then waits for its list to close: the next Select lists the same labels. */
async function pick(scope: Locator, label: string, choice: string) {
  await chooseOption(scope, label, choice);
  await expect(scope.page().locator(POPOVER)).toHaveCount(0);
}

/** An Approved Model to run evals on; the fake answers whatever the model. */
async function approvedModel(request: APIRequestContext) {
  const listed = await request.get(`${E2E.apiUrl}/settings/ai/models`, { headers: asPim });
  const { models } = (await listed.json()) as { models: { displayName: string }[] };
  if (models.length) return;
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
}

test('an Admin writes a Prompt Version, evaluates it against the default, approves it and rolls back', async ({
  as,
  request,
}) => {
  await approvedModel(request);
  const page = await as(pim);
  await page.goto('/settings/ai/prompts');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'AI prompts' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'AI prompts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(dialog.getByTestId('active-generate-choices')).toHaveText('Default');
  await dialog.getByRole('link', { name: 'generate-choices', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'generate-choices' })).toBeVisible();
  await expect(dialog.getByTestId('active-version')).toContainText('Active: Default');

  // Write a version: the active prompt, one line added. It waits for approval.
  await dialog.getByRole('button', { name: 'Write a new version' }).click();
  const prompt = dialog.getByLabel('Prompt', { exact: true });
  await expect(prompt).toHaveValue(/\{\{spec\}\}/);
  await prompt.fill(`${await prompt.inputValue()}\n${LINE}\n`);
  await dialog.getByLabel('What it changes, and why').fill('Shorter Choices');
  await dialog.getByRole('button', { name: 'Propose' }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    'Proposed. Run evals on it, then approve it.',
  );
  const v1 = dialog.getByRole('listitem', { name: 'v1' });
  await expect(v1).toContainText('Waiting for approval');
  await expect(v1).toContainText('Shorter Choices');
  await expect(dialog.getByTestId('active-version')).toContainText('Active: Default');

  // The diff from the default: an empty line and the new one added.
  const compare = dialog.getByRole('region', { name: 'Compare versions' });
  await pick(compare, 'From', 'Default');
  await pick(compare, 'To', 'v1');
  await compare.getByRole('button', { name: 'Show the diff' }).click();
  await expect(compare.getByRole('figure')).toContainText('Default → v1');
  await expect(compare.getByRole('figure')).toContainText('2 added, 0 removed');
  await expect(compare.getByRole('figure')).toContainText(LINE);

  // Evals on v1, then on the default, on the eval cases; both end with a score.
  const evals = dialog.getByRole('region', { name: 'Evals' });
  for (const version of ['v1', 'Default']) {
    await pick(evals, 'Version', version);
    await evals.getByRole('button', { name: 'Run evals' }).click();
    await expect(evals.getByRole('status')).toHaveText('The eval run started.');
  }
  const runs = evals.getByTestId('eval-run');
  await expect(runs).toHaveCount(2);
  await expect(evals.getByTestId('eval-score').first()).toHaveText(/^\d+%/, { timeout: 20_000 });
  await expect(evals.getByTestId('eval-score').nth(1)).toHaveText(/^\d+%/, { timeout: 20_000 });

  // A run's cases, each with its checks; then the two runs side by side.
  await runs.first().getByRole('button', { name: 'Cases' }).click();
  await expect(evals.getByText('Provider has no webhook for payment status')).toBeVisible();
  await expect(evals.getByText('A valid answer').first()).toBeVisible();
  await evals.getByRole('button', { name: 'Compare', exact: true }).click();
  const comparison = evals.getByTestId('eval-comparison');
  await expect(comparison).toContainText('A: v1 on Best');
  await expect(comparison).toContainText('B: Default on Best');
  await expect(comparison.getByRole('row', { name: /^Choices/ })).toBeVisible();
  await comparison.getByText('Provider has no webhook for payment status', { exact: true }).click();
  await expect(comparison.getByText('"suggestedRole": "PO"').first()).toBeVisible();
  // The page, with its versions, runs and comparison open, is axe-clean.
  await expectNoViolations(page);

  // Approve: v1 is active. Then roll back to the default, recorded in the history.
  await v1.getByRole('button', { name: 'Approve v1' }).click();
  await expect(dialog.getByTestId('active-version')).toContainText('Active: v1');
  await expect(v1).toContainText('Active');
  await dialog.getByRole('button', { name: 'Roll back to the default' }).click();
  await expect(dialog.getByTestId('active-version')).toContainText('Active: Default');
  const history = dialog.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText('rolled back to Default');
  await expect(history.getByRole('listitem').nth(1)).toContainText('approved v1');
  await expect(v1.getByRole('button', { name: 'Roll back to v1' })).toBeVisible();
});

test('a Member gets no AI prompts, and the API refuses them', async ({ as, request }) => {
  const page = await as(beam);
  await page.goto('/settings/ai/prompts');
  await expect(
    page.getByText('Only an Organization Admin can change the AI prompts.'),
  ).toBeVisible();
  const res = await request.post(`${E2E.apiUrl}/settings/ai/prompts/generate-choices/rollback`, {
    headers: asBeam,
    data: { version: 0 },
  });
  expect(res.status()).toBe(403);
});
