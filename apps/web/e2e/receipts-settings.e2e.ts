import { readFile } from 'node:fs/promises';
import { RECEIPT_EXPORT_FORMAT, ReceiptExportLine } from '@vorasaan/shared';
import { E2E } from './env';
import { beam, expect, pim, SEED, test, unique } from './fixtures';

// Settings → AI → Receipts (ticket 0070): an Admin sees how many Receipts are kept, turns
// collection off and on, sets the retention, and downloads the JSONL export, in which no
// person's name or email appears. A Member can't see it.

const asBeam = { 'x-vorasaan-user': beam.id };

test('an Admin manages Receipts and exports them without names or emails', async ({
  as,
  request,
}) => {
  // An AI call leaves a Receipt: Beam raises a Blocker, and the fake drafts its Choices.
  const raised = await request.post(`${E2E.apiUrl}/decision-requests`, {
    headers: asBeam,
    data: {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: unique('Receipts e2e'),
      description: 'Only polling is available.',
    },
  });
  expect(raised.status()).toBe(201);

  const page = await as(pim);
  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
  const section = dialog.getByRole('region', { name: 'Receipts' });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId('receipt-count')).toContainText(/\d+ Receipts? kept/);

  // Collection off, then on again: it is saved at once and survives a reload.
  const collect = section.getByRole('switch', { name: 'Keep a Receipt of every AI call' });
  await expect(collect).toBeChecked();
  // The kit Switch's native input is visually hidden inside its label: click the label.
  await collect.locator('xpath=ancestor::label[1]').click();
  await expect(section.getByRole('status')).toHaveText('No new Receipts will be kept.');
  await page.reload();
  await expect(
    dialog.getByRole('switch', { name: 'Keep a Receipt of every AI call' }),
  ).not.toBeChecked();
  await dialog
    .getByRole('switch', { name: 'Keep a Receipt of every AI call' })
    .locator('xpath=ancestor::label[1]')
    .click();
  await expect(dialog.getByRole('status')).toHaveText('Receipts are being kept.');

  // Retention: 30 days, saved; then back to the default.
  const days = dialog.getByLabel('Keep Receipts for (days)');
  await days.fill('30');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(dialog.getByLabel('Keep Receipts for (days)')).toHaveValue('30');
  await dialog.getByLabel('Keep Receipts for (days)').fill('90');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');

  // The export: one Receipt per line, each parsing with the shared schema, no names or emails.
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Export (JSONL)' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^vorasaan-receipts-.*\.jsonl$/);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  const parsed = lines.map((line) => ReceiptExportLine.parse(JSON.parse(line)));
  expect(parsed.every((l) => l.format === RECEIPT_EXPORT_FORMAT)).toBe(true);
  expect(parsed.some((l) => l.task === 'generateChoices')).toBe(true);
  for (const person of Object.values(SEED.users)) {
    expect(text).not.toContain(person.email);
    expect(text).not.toContain(person.id);
  }
});

test('a Member gets no Receipts settings and no export', async ({ as, request }) => {
  const page = await as(beam);
  await page.goto('/settings/ai');
  await expect(
    page.getByText('Only an Organization Admin can change the AI models.'),
  ).toBeVisible();
  const res = await request.get(`${E2E.apiUrl}/settings/ai/receipts/export`, { headers: asBeam });
  expect(res.status()).toBe(403);
});
