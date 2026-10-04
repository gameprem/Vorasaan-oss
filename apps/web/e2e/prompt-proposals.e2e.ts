import type { APIRequestContext } from '@playwright/test';
import { E2E } from './env';
import { beam, expect, expectNoViolations, pim, SEED, test, unique } from './fixtures';

// The AI proposes better prompts (ticket 0072). People ask for shorter Choices again and
// again; an Admin has the AI read that feedback, sees the pattern it names with its cases,
// reviews the Prompt Version it proposed (its diff and the evals before and after, with
// sample outputs), asks for a Redraft, and approves it. A Member gets none of it.
//
// It works on the redraft-choices prompt: Request changes on a Redraft after the first is
// feedback on the Redraft that prompt wrote. (The Choices prompt is prompt-versions.e2e's.)

const asPim = { 'x-vorasaan-user': pim.id };
const asBeam = { 'x-vorasaan-user': beam.id };
const PROMPT = 'redraft-choices';
const SHORTER = 'Shorter please, this is too long to read on my phone.';

/** An Approved Model to run evals on; the fake answers whatever the model. */
async function approvedModel(request: APIRequestContext) {
  const listed = await request.get(`${E2E.apiUrl}/settings/ai/models`, { headers: asPim });
  const { models } = (await listed.json()) as { models: unknown[] };
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

/**
 * Beam raises a Blocker and asks for changes to its Choices three times: the second and third
 * are feedback on Redrafts the redraft-choices prompt wrote.
 */
async function feedback(request: APIRequestContext) {
  const raised = await request.post(`${E2E.apiUrl}/decision-requests`, {
    headers: asBeam,
    data: {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: unique('Provider has no webhook'),
      description: 'Only polling is available.',
    },
  });
  expect(raised.status()).toBe(201);
  const { id } = (await raised.json()) as { id: string };
  for (let i = 0; i < 3; i++) {
    const res = await request.post(
      `${E2E.apiUrl}/decision-requests/${id}/choices/request-changes`,
      {
        headers: asBeam,
        data: { feedback: SHORTER },
      },
    );
    expect(res.status()).toBe(201);
  }
}

test('an Admin has the AI read the feedback, reviews its proposal with evals, asks for a Redraft and approves it', async ({
  as,
  request,
}) => {
  await approvedModel(request);
  await feedback(request);
  await feedback(request);

  const page = await as(pim);
  await page.goto('/settings/ai/prompts');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByTestId(`feedback-${PROMPT}`)).toHaveText(/^[1-9]\d*$/);
  await dialog.getByRole('link', { name: PROMPT, exact: true }).click();
  await expect(dialog.getByRole('heading', { name: PROMPT })).toBeVisible();

  // The AI reads the feedback; the page refreshes until it is done.
  const section = dialog.getByRole('region', { name: 'Feedback' });
  await expect(section.getByTestId('new-feedback')).toContainText('new outcomes');
  await section.getByRole('button', { name: 'Analyze feedback now' }).click();
  const proposed = section.getByRole('link', { name: 'Proposed v1 →' });
  await expect(proposed).toBeVisible({ timeout: 20_000 });
  const patterns = section.getByRole('list', { name: 'Patterns' }).first();
  await expect(patterns).toContainText('Often asked to be shorter');
  await patterns.getByText('The cases').first().click();
  await expect(patterns.getByText(SHORTER).first()).toBeVisible();

  // The version waits for approval; it is reviewed on its own page.
  const v1 = dialog.getByRole('listitem', { name: 'v1' });
  await expect(v1).toContainText('Proposed by the AI');
  await expect(v1).toContainText('Waiting for approval');
  await expect(dialog.getByTestId('active-version')).toContainText('Active: Default');
  await proposed.click();
  await expect(dialog.getByRole('heading', { name: `v1 of ${PROMPT}` })).toBeVisible();
  await expect(dialog.getByTestId('proposal-version')).toContainText('Often asked to be shorter');

  // The patterns, the diff from the default, and the evals before and after, side by side.
  await expect(
    dialog.getByRole('region', { name: 'What people asked for' }).getByTestId('pattern-count'),
  ).toContainText('cases');
  const changes = dialog.getByRole('region', { name: 'Changes' });
  await expect(changes.getByRole('figure')).toContainText('Default → v1');
  await expect(changes.getByRole('figure')).toContainText(
    'Learned from feedback: Often asked to be shorter',
  );
  const evals = dialog.getByRole('region', { name: 'Evals' });
  await expect(evals.getByTestId('score-before')).toContainText(/\d+%/, { timeout: 20_000 });
  await expect(evals.getByTestId('score-after')).toContainText(/\d+%/, { timeout: 20_000 });
  const comparison = evals.getByTestId('eval-comparison');
  await expect(comparison).toContainText('A: Default on Best');
  await expect(comparison).toContainText('B: v1 on Best');
  await comparison.locator('summary').first().click();
  await expect(comparison.getByText('"choices"').first()).toBeVisible();
  await expectNoViolations(page);

  // Request changes: Redraft 2, and its evals run again.
  const decide = dialog.getByRole('region', { name: 'Decide' });
  await decide.getByRole('button', { name: 'Request changes' }).click();
  await decide
    .getByLabel('What should the AI change?')
    .fill('Also keep every Choice under 40 words.');
  await decide.getByRole('button', { name: 'Ask for a Redraft' }).click();
  await expect(decide.getByRole('button', { name: 'Redraft 2 (current)' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(changes.getByRole('figure')).toContainText('under 40 words');
  await expect(evals.getByTestId('score-after')).toContainText(/\d+%/, { timeout: 20_000 });

  // Nothing changed until now. Approve: v1, as redrafted, is active.
  await decide.getByRole('button', { name: 'Approve v1' }).click();
  const decided = dialog.getByRole('region', { name: 'Decided' });
  await expect(decided).toContainText('Approved by Pim: it is active.');
  await dialog.getByRole('link', { name: `← ${PROMPT}` }).click();
  await expect(dialog.getByTestId('active-version')).toContainText('Active: v1');

  // Rollback works as for any version: back to the default.
  await dialog.getByRole('button', { name: 'Roll back to the default' }).click();
  await expect(dialog.getByTestId('active-version')).toContainText('Active: Default');
});

test('a Member gets no proposals, and the API refuses them', async ({ as, request }) => {
  const page = await as(beam);
  await page.goto(`/settings/ai/prompts/${PROMPT}/proposals/1`);
  await expect(
    page.getByText('Only an Organization Admin can change the AI prompts.'),
  ).toBeVisible();
  const analyses = await request.post(`${E2E.apiUrl}/settings/ai/prompts/${PROMPT}/analyses`, {
    headers: asBeam,
  });
  expect(analyses.status()).toBe(403);
  const settings = await request.put(`${E2E.apiUrl}/settings/ai/prompt-analysis`, {
    headers: asBeam,
    data: { analysisAfter: 1 },
  });
  expect(settings.status()).toBe(403);
});
