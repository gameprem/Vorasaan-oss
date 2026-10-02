import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E } from './env';
import { beam, expect, pim, SEED, test, unique } from './fixtures';

/** Makes the request's window run out `minutes` ago, with escalation at `step`. */
function age(requestId: string, minutes: number, step: number) {
  execFileSync(
    'bun',
    [
      fileURLToPath(new URL('./age-request.ts', import.meta.url)),
      requestId,
      String(minutes),
      String(step),
    ],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: E2E.databaseUrl } },
  );
}

test('an Admin sees the Response Windows in Settings; a Member only reads them', async ({ as }) => {
  const admin = await as(pim);
  await admin.goto('/settings/response-windows');
  await expect(admin.getByRole('heading', { name: 'Response Windows', level: 2 })).toBeVisible();
  await expect(admin.getByLabel('Blocker: how many', { exact: true })).toHaveValue('4');
  await admin.getByRole('button', { name: 'Save Response Windows' }).click();
  await expect(admin.getByRole('status').getByText('Saved')).toBeVisible();

  const member = await as(beam);
  await member.goto('/settings/response-windows');
  await expect(
    member.getByText('Only an Organization Admin can change the Response Windows.'),
  ).toBeVisible();
  await expect(member.getByRole('button', { name: 'Save Response Windows' })).toHaveCount(0);
});

test('the Inbox and My Requests show "due in", then "overdue" and "escalated"', async ({ as }) => {
  const title = unique('Drop the legacy payment page?');

  // Beam raises a Blocker; the draft review offers the Project's window, to shorten only.
  const raiser = await as(beam);
  await raiser.goto(`/features/${SEED.featureId}/raise`);
  await raiser.getByLabel('Blocker').check();
  await raiser.getByLabel('Title').fill(title);
  await raiser.getByLabel('Description').fill('Nobody has used it for a year.');
  await raiser.getByRole('button', { name: 'Continue to review' }).click();
  await expect(raiser).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestId = raiser.url().split('/').at(-1) ?? '';
  await expect(raiser.getByRole('heading', { name: 'Response Window' })).toBeVisible();
  await expect(raiser.getByText('This Project gives a Blocker 4 working hours.')).toBeVisible();
  await raiser.getByLabel('Only Pim').check();
  await raiser.getByRole('button', { name: 'Send now' }).click();
  await expect(raiser.getByText(/for Pim to decide\./)).toBeVisible();

  const decider = await as(pim);
  const row = () =>
    decider
      .getByRole('region', { name: /Waiting for your decision/ })
      .getByRole('listitem')
      .filter({ hasText: title });
  await decider.goto('/inbox');
  await expect(row().getByTestId('response-window')).toHaveText(/^due in \d+[mhd]$/);

  // It waited past its window, and escalation added the Delegates.
  age(requestId, 61, 2);
  await decider.reload();
  await expect(row().getByTestId('response-window')).toHaveText('overdue 1hescalated');
  await expect(row().getByText('overdue 1h')).toBeVisible();
  await expect(row().getByText('escalated')).toBeVisible();

  await raiser.goto('/requests');
  const mine = raiser.getByRole('listitem').filter({ hasText: title });
  await expect(mine.getByText('overdue 1h')).toBeVisible();
  await expect(mine.getByText('escalated')).toBeVisible();
});
