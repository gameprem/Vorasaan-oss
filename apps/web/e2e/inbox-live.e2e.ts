import { beam, expect, pim, SEED, test, unique } from './fixtures';

test('the Inbox updates live, without a reload', async ({ as }) => {
  const title = unique('Retry a failed payment automatically?');

  // Pim opens her Inbox and waits until its live event stream is connected.
  const inbox = await as(pim);
  const stream = inbox.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
  );
  await inbox.goto('/inbox');
  await stream;
  await expect(inbox.getByText(title)).toHaveCount(0);
  // Gone if the page reloads; a client-side refresh keeps it.
  await inbox.evaluate(() => {
    (window as { e2eNoReload?: boolean }).e2eNoReload = true;
  });

  // Meanwhile Beam raises a Question and sends it to Pim only.
  const raiser = await as(beam);
  await raiser.goto(`/features/${SEED.featureId}/raise`);
  await raiser.getByLabel('Question').check();
  await raiser.getByLabel('Title').fill(title);
  await raiser.getByLabel('Description').fill('The provider allows one retry per order.');
  await raiser.getByRole('button', { name: 'Continue to review' }).click();
  await expect(raiser).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await raiser.getByLabel('Only Pim').check();
  await raiser.getByRole('button', { name: 'Send now' }).click();
  await expect(raiser.getByText(/for Pim to decide\./)).toBeVisible();

  // It appears in Pim's open Inbox on its own.
  await expect(
    inbox.getByRole('region', { name: /Waiting for your decision/ }).getByText(title),
  ).toBeVisible({ timeout: 15_000 });
  expect(await inbox.evaluate(() => (window as { e2eNoReload?: boolean }).e2eNoReload)).toBe(true);
});
