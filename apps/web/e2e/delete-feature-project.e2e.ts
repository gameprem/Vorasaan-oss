import type { APIRequestContext, Page } from '@playwright/test';
import { E2E } from './env';
import {
  beam,
  expect,
  expectNoViolations,
  fern,
  mint,
  pim,
  SEED,
  THEMES,
  test,
  unique,
} from './fixtures';

// Deleting a Feature or a Project (ticket 0049). Each test deletes only what it created
// itself: the seeded Project, Team and Feature stay for the other specs.

const asPim = { 'x-vorasaan-user': pim.id };

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${E2E.apiUrl}${path}`, { headers: asPim, data });
  expect(res.status()).toBe(201);
  return (await res.json()) as T;
}

/** Opens `path` and waits until its live event stream is connected. */
async function openLive(page: Page, path: string) {
  const stream = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
  );
  await page.goto(path);
  await stream;
}

test('a PO deletes a Feature by typing its name; a page showing it moves away', async ({
  as,
  request,
}) => {
  const title = unique('Delete me');
  const feature = await post<{ id: string }>(request, `/teams/${SEED.teamId}/features`, {
    title,
  });
  // Mint (a PO, not an Admin) owns it as its PO.
  const owners = await request.put(`${E2E.apiUrl}/features/${feature.id}/role-owners`, {
    headers: asPim,
    data: { owners: [{ userId: mint.id, role: 'PO' }] },
  });
  expect(owners.status()).toBe(200);

  // Beam, not its PO, can't delete it.
  const backend = await as(beam);
  await backend.goto(`/features/${feature.id}`);
  await expect(backend.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(backend.getByRole('button', { name: 'Delete Feature' })).toHaveCount(0);

  // Fern has it open meanwhile.
  const watcher = await as(fern);
  await openLive(watcher, `/features/${feature.id}`);

  const po = await as(mint);
  await po.goto(`/features/${feature.id}`);
  await po.getByRole('button', { name: 'Delete Feature' }).click();
  const dialog = po.getByRole('alertdialog', { name: `Delete the Feature “${title}”?` });
  await expect(dialog).toBeVisible();
  for (const theme of THEMES) {
    await po.emulateMedia({ colorScheme: theme });
    await expectNoViolations(po, '[role="alertdialog"]');
  }

  // Only the exact name enables it; typing starts in the field, Enter deletes.
  const name = dialog.getByLabel('Type the Feature’s name to confirm');
  await expect(name).toBeFocused();
  await po.keyboard.type('Delete');
  await expect(dialog.getByRole('button', { name: 'Delete Feature' })).toBeDisabled();
  await name.fill(title);
  await expect(dialog.getByRole('button', { name: 'Delete Feature' })).toBeEnabled();
  await po.keyboard.press('Enter');

  await expect(po).toHaveURL(new RegExp(`/projects/${SEED.projectId}$`));
  await expect(po.getByText(`Deleted the Feature “${title}”.`).first()).toBeAttached();
  const res = await request.get(`${E2E.apiUrl}/features/${feature.id}`, { headers: asPim });
  expect(res.status()).toBe(404);

  // Fern's page moved to the Project and said why.
  await expect(watcher).toHaveURL(new RegExp(`/projects/${SEED.projectId}$`), {
    timeout: 15_000,
  });
  await expect(watcher.getByText(`The Feature “${title}” was deleted.`).first()).toBeAttached();
});

test('an Admin deletes a Project from the keyboard; its Team page moves away', async ({
  as,
  request,
}) => {
  const name = unique('Doomed app');
  const project = await post<{ id: string }>(request, '/projects', { name });
  const team = await post<{ id: string }>(request, `/projects/${project.id}/teams`, {
    name: 'Core',
  });
  await post(request, `/teams/${team.id}/features`, { title: 'Top up' });

  // Beam, a Member, sees no delete; he keeps the Team page open.
  const member = await as(beam);
  await member.goto(`/projects/${project.id}`);
  await expect(member.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Delete Project' })).toHaveCount(0);
  await openLive(member, `/teams/${team.id}`);

  const admin = await as(pim);
  await admin.goto(`/projects/${project.id}`);
  const open = admin.getByRole('button', { name: 'Delete Project' });
  await open.focus();
  await admin.keyboard.press('Enter');
  const dialog = admin.getByRole('alertdialog', { name: `Delete the Project “${name}”?` });
  await expect(dialog).toBeVisible();
  // Escape cancels and leaves everything as it was.
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await open.focus();
  await admin.keyboard.press('Enter');
  await admin.keyboard.type(name);
  await admin.keyboard.press('Enter');

  await expect(admin).toHaveURL(/\/projects$/);
  await expect(admin.getByText(`Deleted the Project “${name}”.`).first()).toBeAttached();
  await expect(admin.getByRole('link', { name, exact: true })).toHaveCount(0);

  await expect(member).toHaveURL(/\/projects$/, { timeout: 15_000 });
  await expect(member.getByText(`The Project “${name}” was deleted.`).first()).toBeAttached();
});
