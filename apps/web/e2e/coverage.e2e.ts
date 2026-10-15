import type { APIRequestContext } from '@playwright/test';
import type { ProjectPlatformsView } from '@vorasaan/shared';
import { E2E } from './env';
import {
  beam,
  chooseOption,
  expect,
  expectNoViolations,
  pim,
  SEED,
  THEMES,
  test,
  tick,
  unique,
} from './fixtures';

// Platforms and Coverage in the web app (ticket 0052): a Project's Platforms tab, the Feature
// header's Coverage chips, adding a missing section from chat, the Project's Coverage matrix
// and Settings → Platforms. Every spec puts the seeded Project's Platforms and its Features'
// targets back as it found them, since other specs (and the fake AI's Grilling) read them.

const asPim = { 'x-vorasaan-user': pim.id };
const PLATFORMS = `${E2E.apiUrl}/projects/${SEED.projectId}/platforms`;

type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; args: unknown } };

async function scriptChat(request: APIRequestContext, ...replies: { chunks: Chunk[] }[]) {
  const res = await request.post(`${E2E.apiUrl}/dev/fake-ai/chat-script`, {
    headers: asPim,
    data: { replies },
  });
  expect(res.status()).toBe(204);
}

/** A new Feature in the seeded Team, created through the API as Pim, without a Spec. */
async function createFeature(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post(`${E2E.apiUrl}/teams/${SEED.teamId}/features`, {
    headers: asPim,
    data: { title },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function projectPlatforms(request: APIRequestContext) {
  const res = await request.get(PLATFORMS, { headers: asPim });
  return ((await res.json()) as ProjectPlatformsView).platforms;
}

async function target(request: APIRequestContext, featureId: string, platformIds: string[]) {
  const res = await request.put(`${E2E.apiUrl}/features/${featureId}/platforms`, {
    headers: asPim,
    data: { platformIds },
  });
  expect(res.status()).toBe(200);
}

let created: string[] = [];
let platformsBefore: Awaited<ReturnType<typeof projectPlatforms>> = [];

test.beforeEach(async ({ request }) => {
  created = [];
  platformsBefore = await projectPlatforms(request);
});

test.afterEach(async ({ request }) => {
  for (const featureId of created) await target(request, featureId, []);
  const res = await request.put(PLATFORMS, {
    headers: asPim,
    data: { platforms: platformsBefore.map(({ position: _position, ...p }) => p) },
  });
  expect(res.status()).toBe(200);
});

test('a Flutter Platform is added to a Project, a Feature targets it and shows it missing; a section added in chat covers it', async ({
  as,
  request,
}) => {
  const title = unique('Order tracking');
  const featureId = await createFeature(request, title);
  created.push(featureId);
  const page = await as(pim);

  // Project → Platforms: add Flutter, answered by Mobile, without "Someone to ask" and
  // "QA ready" (nobody in the seeded Team holds Mobile or QA).
  await page.goto(`/projects/${SEED.projectId}?tab=platforms`);
  const list = page.getByRole('list', { name: 'Platforms' });
  await expect(list.getByRole('listitem')).toHaveCount(platformsBefore.length);
  await expect(async () => {
    await page.getByRole('button', { name: 'Add a Platform' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(platformsBefore.length + 1, {
      timeout: 1000,
    });
  }).toPass();
  const row = list.getByRole('listitem').last();
  await expect(row.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await row.getByRole('textbox', { name: 'Name' }).fill('Flutter');
  await tick(row.getByRole('checkbox', { name: 'Mobile' }));
  // A kit Checkbox's native input is hidden inside its label: untick by clicking the label.
  for (const check of [/^Someone to ask/, /^QA ready/]) {
    await row.getByRole('checkbox', { name: check }).locator('xpath=ancestor::label[1]').click();
  }
  await expect(row.getByRole('checkbox', { name: /^Someone to ask/ })).not.toBeChecked();
  await expect(row.getByRole('checkbox', { name: /^QA ready/ })).not.toBeChecked();
  await expectNoViolations(page, 'main');
  await page.getByRole('button', { name: 'Save Platforms' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  // The Feature targets Back-End and Flutter: Flutter shows as missing, with its reason.
  await page.goto(`/features/${featureId}`);
  const targets = page.getByRole('group', { name: 'Choose target Platforms' });
  await tick(targets.getByRole('checkbox', { name: 'Back-End' }));
  await tick(targets.getByRole('checkbox', { name: 'Flutter' }));
  await targets.getByRole('button', { name: 'Save Platforms' }).click();
  const header = page.getByRole('list', { name: 'Target Platforms' });
  const flutter = header.getByRole('button', { name: 'Flutter: missing' });
  await expect(flutter).toBeVisible();
  await expect(header.getByRole('button', { name: 'Back-End: missing' })).toBeVisible();

  // Its reason on a press (a tap on a phone), with what can be done about it.
  await flutter.click();
  const details = page.getByRole('dialog', { name: 'Flutter Coverage' });
  await expect(details).toContainText('No Spec section');
  await expectNoViolations(page, '[role="dialog"]');
  await details.getByRole('link', { name: 'Ask the AI to add a Flutter section' }).click();

  // In chat, the AI proposes the section as an Action Card; approving it adds it.
  await expect(page).toHaveURL(/\/conversations\/new\?feature=.*&section=Flutter/);
  await page.getByRole('button', { name: 'Add a Flutter section to the Spec' }).click();
  const message = page.getByRole('textbox', { name: 'Message' });
  await expect(message).toHaveValue('Add a Flutter section to the Spec');
  const spec = `# ${title}\n\n## Goal\n\nCustomers see where their order is.\n\n## Back-End\n\n- Order status events.\n\n## Flutter\n\n- The order card shows the latest status.\n`;
  await scriptChat(
    request,
    {
      chunks: [
        { type: 'text', delta: 'I drafted a Flutter section. ' },
        {
          type: 'tool-call',
          call: {
            id: 'e2e-flutter',
            name: 'draftSpecProposal',
            args: { proposedMarkdown: spec, summary: 'Adds a Flutter section.' },
          },
        },
      ],
    },
    { chunks: [{ type: 'text', delta: 'It waits for your approval.' }] },
  );
  await message.press('Enter');
  const card = page.getByRole('article', { name: `Change the Spec of "${title}"` });
  await expect(card).toContainText('Proposed');
  await card.getByRole('button', { name: 'Approve Spec change' }).click();
  await expect(card).toContainText('Approved · Spec v1');

  // Flutter is covered now.
  await page.goto(`/features/${featureId}`);
  await expect(header.getByRole('button', { name: 'Flutter: covered' })).toBeVisible();
  await expectNoViolations(page, 'main');
});

for (const theme of THEMES) {
  test(`the Coverage matrix filters to missing QA, and scrolls inside itself at 375px (${theme})`, async ({
    as,
    request,
  }) => {
    const title = unique('Refund status');
    const featureId = await createFeature(request, title);
    created.push(featureId);
    const backEnd = platformsBefore.find((p) => p.name === 'Back-End');
    if (!backEnd) throw new Error('The seeded Project has no Back-End');
    await target(request, featureId, [backEnd.id]);

    const page = await as(pim);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/projects/${SEED.projectId}?tab=coverage`);
    const matrix = page.getByRole('region', { name: 'Coverage matrix' });
    const row = matrix.getByRole('row').filter({ hasText: title });
    await expect(row).toContainText('Missing QA');
    await expect(row).toContainText('Not targeted');

    // The matrix is wider than the phone and scrolls in its own region; the page doesn't.
    const widths = await matrix.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(widths.scroll).toBeGreaterThan(widths.client);
    expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    await matrix.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => matrix.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    // Missing only, then for missing QA: the Feature stays; the filter is in the address.
    await page.getByText('Missing only', { exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Missing only' })).toBeChecked();
    await chooseOption(page, 'Reason', 'Missing QA');
    await expect(page).toHaveURL(/missing=1&reason=QA_READY/);
    await expect(
      page.getByRole('status').filter({ hasText: /^Showing \d+ of \d+ Features$/ }),
    ).toBeVisible();
    await expect(row).toBeVisible();
    // A Feature targeting nothing is never missing anything.
    await expect(matrix.getByRole('row').filter({ hasText: 'Async checkout' })).toHaveCount(0);
    await expectNoViolations(page, 'main');

    // Reloading keeps the filter.
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Missing only' })).toBeChecked();
    await expect(matrix.getByRole('row').filter({ hasText: title })).toBeVisible();
  });

  test(`Settings → Platforms: an Admin edits the template by keyboard; a Member reads it (${theme})`, async ({
    as,
  }) => {
    const admin = await as(pim);
    await admin.emulateMedia({ colorScheme: theme });
    await admin.goto('/settings/platforms');
    await expect(admin.getByRole('heading', { name: 'Platforms', level: 2 })).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    const list = admin.getByRole('list', { name: 'Platforms' });
    await expect(list.getByRole('listitem')).toHaveCount(3);

    // Move Mobile up with the keyboard; the focus stays on it.
    const up = admin.getByRole('button', { name: 'Move Mobile up' });
    await up.focus();
    await admin.keyboard.press('Enter');
    await expect(
      admin.getByRole('status').filter({ hasText: 'Mobile moved to position 2' }),
    ).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Move Mobile up' })).toBeFocused();
    await expect(list.getByRole('listitem').nth(1)).toContainText('2. Mobile');

    // Removing it keeps its message, announced from outside the list.
    await admin.getByRole('button', { name: 'Remove Mobile' }).focus();
    await admin.keyboard.press('Enter');
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(admin.getByRole('status').filter({ hasText: 'Mobile removed' })).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Remove Front-End' })).toBeFocused();
    await expectNoViolations(admin);

    const member = await as(beam);
    await member.emulateMedia({ colorScheme: theme });
    await member.goto('/settings/platforms');
    await expect(
      member.getByText('Only an Organization Admin can change the Platform template.'),
    ).toBeVisible();
    await expect(member.getByRole('button', { name: 'Save Platform template' })).toHaveCount(0);
    await expect(member.getByRole('list', { name: 'Platforms' })).toContainText('Back-End');
    await expectNoViolations(member);
  });
}
