import { expect, pim, SEED, test } from './fixtures';

test('edit the Spec → see the diff → revert', async ({ as }) => {
  const marker = `Edited end to end ${Date.now().toString(36)}`;
  const summary = 'Add a line from the end-to-end test';

  const page = await as(pim);
  await page.goto(`/features/${SEED.featureId}`);
  const meta = await page.getByText(/^Spec v\d+, approved by /).textContent();
  const base = Number(/^Spec v(\d+)/.exec(meta ?? '')?.[1]);
  expect(base).toBeGreaterThan(0);

  // Edit in the block editor: a new line at the end of the Spec.
  await page.getByRole('button', { name: 'Edit Spec' }).click();
  const editor = page.locator('.bn-editor[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.locator('.bn-block-content').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(marker);
  await page.getByLabel(/What changed\?/).fill(summary);
  await page.getByRole('button', { name: `Save as v${base + 1}` }).click();

  await expect(page.getByText(new RegExp(`^Spec v${base + 1}, approved by Pim`))).toBeVisible();
  await expect(page.locator('.spec').getByText(marker)).toBeVisible();

  // The diff of the new version against the one before shows the added line.
  await page.getByRole('link', { name: /^Version history/ }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: summary })
    .getByRole('link', { name: `Compare with v${base}` })
    .click();
  const diff = page.locator('figure').filter({ hasText: `v${base} → v${base + 1}` });
  await expect(diff).toBeVisible();
  // BlockNote re-serializes the whole Spec, so other lines may change form too.
  await expect(
    diff.locator('div').filter({ hasText: `Added: ` }).filter({ hasText: marker }),
  ).toHaveCount(1);

  // Revert to the version before the edit: it comes back as a new version.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Revert to v${base}` }).click();
  await expect(
    page.getByRole('listitem').filter({ hasText: `Reverted from v${base}, approved by Pim` }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Spec', exact: true }).click();
  await expect(page.getByText(new RegExp(`^Spec v${base + 2}, approved by Pim`))).toBeVisible();
  await expect(page.locator('.spec').getByText(marker)).toHaveCount(0);
});
