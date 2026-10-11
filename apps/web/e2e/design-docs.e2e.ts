import type { APIRequestContext, Page } from '@playwright/test';
import type { ProjectPlatformsView, SpecVersionView } from '@vorasaan/shared';
import { E2E } from './env';
import { beam, expect, expectNoViolations, pim, SEED, THEMES, test, unique } from './fixtures';

// Design Docs per Platform (ticket 0069), against the real server with VORASAAN_AI=fake: once
// a Feature's Spec is approved and its Back-End Coverage is complete, the fake drafts the
// Back-End and QA Design Docs from the Spec (each template section, the Spec's criteria
// traced, its open question raised). Beam, the Back-End Role Owner, asks for a Redraft and
// approves it; a Spec change makes it stale and the AI proposes an update. Every spec puts
// the seeded Project's Platforms and templates back.

const asPim = { 'x-vorasaan-user': pim.id };
const PLATFORMS = `${E2E.apiUrl}/projects/${SEED.projectId}/platforms`;
const BACK_END = SEED.platforms.backEnd;

const spec = (seconds: number) => `# Order tracking

## Goal
Customers see where their order is.

## Acceptance criteria
- [ ] The order screen shows the latest status.

## Back-End
GET /orders/{id}/status answers within ${seconds} seconds.

### Acceptance criteria
- [ ] A status change is stored once.

## Out of scope
- Refunds.

## Open questions
- How long is a status kept?
`;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function projectPlatforms(request: APIRequestContext) {
  const res = await request.get(PLATFORMS, { headers: asPim });
  return ((await res.json()) as ProjectPlatformsView).platforms;
}

async function writeSpec(request: APIRequestContext, featureId: string, markdown: string) {
  const versions = await request.get(`${E2E.apiUrl}/features/${featureId}/spec-versions`, {
    headers: asPim,
  });
  const latest = ((await versions.json()) as SpecVersionView[])[0];
  const res = await request.post(`${E2E.apiUrl}/features/${featureId}/spec-versions`, {
    headers: asPim,
    data: { markdown, baseVersion: latest?.version ?? 0 },
  });
  expect(res.status()).toBe(201);
}

/** The Feature's Design Docs tab, reloaded until the Back-End Design Doc reads `state`. */
async function untilState(page: Page, featureId: string, state: string) {
  const row = page.getByTestId('design-doc-Back-End');
  await expect(async () => {
    await page.goto(`/features/${featureId}?tab=design-docs`);
    await expect(row).toContainText(state, { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  return row;
}

let platformsBefore: Awaited<ReturnType<typeof projectPlatforms>> = [];
let featureId = '';
let title = '';

test.beforeEach(async ({ request }) => {
  platformsBefore = await projectPlatforms(request);
  title = unique('Order tracking');
  // Nobody in the seeded Team holds QA: Back-End's "QA ready" check is off for these specs.
  const off = await request.put(PLATFORMS, {
    headers: asPim,
    data: {
      platforms: platformsBefore.map(({ position: _p, ...p }) =>
        p.id === BACK_END ? { ...p, qaReady: false } : p,
      ),
    },
  });
  expect(off.status()).toBe(200);
  const created = await request.post(`${E2E.apiUrl}/teams/${SEED.teamId}/features`, {
    headers: asPim,
    data: { title, platformIds: [BACK_END] },
  });
  expect(created.status()).toBe(201);
  featureId = ((await created.json()) as { id: string }).id;
  const owners = await request.put(`${E2E.apiUrl}/features/${featureId}/role-owners`, {
    headers: asPim,
    data: {
      owners: [
        { userId: pim.id, role: 'PO' },
        { userId: beam.id, role: 'BACKEND' },
      ],
    },
  });
  expect(owners.status()).toBe(200);
});

test.afterEach(async ({ request }) => {
  await request.put(`${E2E.apiUrl}/features/${featureId}/platforms`, {
    headers: asPim,
    data: { platformIds: [] },
  });
  const res = await request.put(PLATFORMS, {
    headers: asPim,
    data: { platforms: platformsBefore.map(({ position: _p, ...p }) => p) },
  });
  expect(res.status()).toBe(200);
  await request.delete(`${E2E.apiUrl}/projects/${SEED.projectId}/design-templates/QA`, {
    headers: asPim,
  });
});

test('the AI drafts the Back-End Design Doc from the approved Spec; its Role Owner redrafts and approves it, and a Spec change makes it stale', async ({
  as,
  request,
}) => {
  await writeSpec(request, featureId, spec(2));
  const page = await as(beam);

  // The Design Docs tab: Back-End waits for Beam's approval, QA for a Tech Lead or QA.
  const row = await untilState(page, featureId, 'Waiting for approval');
  await expect(row).toContainText('Approved by a Tech Lead or Backend');
  await expect(row).toContainText('1 question raised');
  await expect(page.getByTestId('design-doc-QA')).toContainText('Waiting for approval');
  await expectNoViolations(page, 'main');

  // Beam's Inbox asks for it.
  await page.goto('/inbox');
  await expect(
    page.getByRole('link', { name: new RegExp(`Back-End Design Doc for ${escapeRe(title)}`) }),
  ).toBeVisible();

  // Its page: the draft from Spec v1 as a diff, the question it raised as a draft Question.
  await page.goto(`/features/${featureId}/design-docs/${BACK_END}`);
  await expect(page.getByRole('heading', { name: 'Back-End Design Doc' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Draft from Spec v1' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Covers: A status change is stored once.');
  const questions = page.getByRole('region', { name: 'Questions raised' });
  await expect(questions.getByRole('link', { name: 'How long is a status kept?' })).toBeVisible();
  await expect(questions).toContainText('raised by Beam');

  // Request changes: Redraft 2, then approve it.
  const form = page.getByRole('form', { name: 'Request changes' });
  await expect(async () => {
    if (!(await form.isVisible()))
      await page.getByRole('button', { name: 'Request changes' }).click();
    await expect(form).toBeVisible({ timeout: 1000 });
  }).toPass();
  const feedback = unique('Name the status table');
  await form.getByLabel('What should the AI change?').fill(feedback);
  await form.getByRole('button', { name: 'Ask for a Redraft' }).click();
  await expect(page.getByRole('button', { name: 'Approve Redraft 2' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(`Changed as asked: ${feedback}`);
  await page.getByRole('button', { name: 'Approve Redraft 2' }).click();
  await expect(page.getByRole('heading', { name: 'Version 1' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Follows Spec v1, approved by Beam');

  // Pim changes the Back-End section: the Design Doc is stale and an update waits.
  await writeSpec(request, featureId, spec(5));
  await untilState(page, featureId, 'Stale');
  await page.goto(`/features/${featureId}/design-docs/${BACK_END}`);
  await expect(page.getByRole('heading', { name: 'Update for Spec v2' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Version 2' })).toBeVisible();

  // The history compares the two versions.
  await page.getByRole('link', { name: 'Compare with v1' }).click();
  await expect(page.getByRole('main')).toContainText('Updated for Spec v2');

  // Pim, the PO, reads it but doesn't approve it.
  const po = await as(pim);
  await po.goto(`/features/${featureId}?tab=design-docs`);
  await expect(po.getByTestId('design-doc-Back-End')).toContainText('Approved');
  await expect(po.getByTestId('design-doc-Back-End')).toContainText('v2 follows Spec v2');
});

for (const theme of THEMES) {
  test(`a Design Doc and the Project's templates in ${theme}, by keyboard and axe-clean`, async ({
    as,
    request,
  }) => {
    await writeSpec(request, featureId, spec(2));
    const page = await as(beam);
    await page.emulateMedia({ colorScheme: theme });
    await untilState(page, featureId, 'Waiting for approval');
    await page.goto(`/features/${featureId}/design-docs/${BACK_END}`);
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expectNoViolations(page, 'main');
    // Decline by keyboard: the reason field, then the button; the status line says it.
    await page.getByRole('button', { name: 'Decline…' }).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Why (optional; the AI learns from it)').fill('Not this release');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'draft is declined' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Draft the Back-End Design Doc' })).toBeVisible();
    await expectNoViolations(page, 'main');

    // The Decision Graph's Design Docs sub-lane.
    await page.goto(`/features/${featureId}?tab=graph`);
    await expect(page.getByRole('region', { name: 'Design Docs' })).toContainText('Back-End');
    await expectNoViolations(page, 'main');

    // Project → Platforms: Pim edits the QA template.
    const po = await as(pim);
    await po.emulateMedia({ colorScheme: theme });
    await po.goto(`/projects/${SEED.projectId}?tab=platforms`);
    const qa = po.getByRole('region', { name: /QA template/ });
    await qa.getByLabel('QA template (Markdown)').fill('## Test plan\n\n## Test cases\n');
    await qa.getByRole('button', { name: 'Save the QA template' }).click();
    await expect(qa.getByRole('status')).toHaveText(
      'The QA template is saved. Drafts from now on use it.',
    );
    await expect(qa).toContainText('(edited for this Project)');
    await expectNoViolations(po, 'main');
  });
}
