import { SEED } from '@vorasaan/db/seed';
import { E2E } from './env';
import { expect, expectNoViolations, pim, test, tick, unique } from './fixtures';

/** A new Feature in the seeded Team, created through the API as Pim, without a Spec. */
async function createFeature(title: string): Promise<string> {
  const res = await fetch(`${E2E.apiUrl}/teams/${SEED.teamId}/features`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vorasaan-user': pim.id },
    body: JSON.stringify({ title }),
  });
  if (res.status !== 201) throw new Error(`Could not create a Feature: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

test("a Feature targets its Project's Platforms, and its first Spec gets a section for each (ticket 0050)", async ({
  as,
}) => {
  const title = unique('Card freeze');
  const featureId = await createFeature(title);
  const page = await as(pim);
  await page.goto(`/features/${featureId}`);

  const targets = page.getByRole('group', { name: 'Choose target Platforms' });
  await expect(targets.getByRole('checkbox')).toHaveCount(3);
  await tick(targets.getByRole('checkbox', { name: 'Back-End' }));
  await tick(targets.getByRole('checkbox', { name: 'Mobile' }));
  await targets.getByRole('button', { name: 'Save Platforms' }).click();
  await expect(targets.getByRole('status')).toHaveText('Saved.');

  // The header lists them, and the first Spec starts with their sections.
  const header = page.getByRole('list', { name: 'Target Platforms' });
  // As Coverage chips (ticket 0052): nothing is written for them yet, so both are missing.
  await expect(header.getByRole('button')).toHaveText(['!Back-End', '!Mobile']);
  await expect(header.getByRole('button', { name: 'Back-End: missing' })).toBeVisible();
  const editor = page.getByRole('region', { name: 'Spec editor' });
  await expect(editor.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(editor.getByRole('heading', { name: 'Back-End', level: 2 })).toBeVisible();
  await expect(editor.getByRole('heading', { name: 'Mobile', level: 2 })).toBeVisible();
  await expect(editor.getByRole('heading', { name: 'Front-End' })).toHaveCount(0);
  // The whole Feature page: the picker, the header list and the Spec editor.
  await expectNoViolations(page, 'main');
});
