import { E2E } from './env';
import { beam, expect, pim, test } from './fixtures';

// The Getting started checklist (ticket 0063) on the seeded Organization: Pim (Admin) sees
// it on the Inbox; the seed already has a Team, a Feature with a Spec and other members,
// so only linking the CLI is left. Beam (Member) never sees it.

test('Getting started: an Admin links the CLI and the checklist completes; Members never see it', async ({
  as,
}) => {
  const member = await as(beam);
  await member.goto('/inbox');
  await expect(member.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(member.getByRole('region', { name: 'Getting started' })).toHaveCount(0);

  const admin = await as(pim);
  await admin.goto('/inbox');
  const checklist = admin.getByRole('region', { name: 'Getting started' });
  await expect(checklist).toBeVisible();
  const item = (name: string) => checklist.getByRole('listitem', { name: new RegExp(`^${name}`) });
  await expect(item('Create a Project and a Team')).toHaveAttribute('data-done', 'true');
  await expect(item('Create a Feature and write its Spec')).toHaveAttribute('data-done', 'true');
  await expect(item('Invite members')).toHaveAttribute('data-done', 'true');
  await expect(item('Link the CLI')).toHaveAttribute('data-done', 'false');

  // Where it's done: Settings → Access tokens. Then the CLI signs in with it.
  await checklist.getByRole('link', { name: /Link the CLI/ }).click();
  const dialog = admin.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Access tokens' })).toBeVisible();
  await dialog.getByLabel('Token name').fill('Laptop CLI');
  await dialog.getByRole('button', { name: 'Create token' }).click();
  const token = await dialog.getByLabel('New access token').inputValue();
  const me = await fetch(`${E2E.apiUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.status).toBe(200); // what `vorasaan login` does

  // Every required item is done: the checklist is gone.
  await admin.goto('/inbox');
  await expect(admin.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(checklist).toHaveCount(0);
});

test('Getting started: dismissing it is remembered', async ({ as }) => {
  const admin = await as(pim);
  // Revoke the CLI's token (from the test above) so the checklist is incomplete again.
  await admin.goto('/settings/tokens');
  // Settings has hydrated once it has moved the focus to Back.
  await expect(admin.getByRole('button', { name: 'Back' })).toBeFocused();
  const revoke = admin.getByRole('button', { name: 'Revoke' });
  if (await revoke.count()) {
    await revoke.first().click();
    await expect(revoke).toHaveCount(0);
  }

  await admin.goto('/inbox');
  const checklist = admin.getByRole('region', { name: 'Getting started' });
  await expect(checklist).toBeVisible();
  await checklist.getByRole('button', { name: 'Dismiss' }).click();
  await expect(checklist).toHaveCount(0);
  await admin.reload();
  await expect(admin.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(checklist).toHaveCount(0);
});
