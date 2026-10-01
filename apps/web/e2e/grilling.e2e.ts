import type { Page } from '@playwright/test';
import { expect, fern, oak, pim, SEED, test } from './fixtures';

const grillingTab = `/projects/${SEED.projectId}?tab=grilling`;

/** Answers every open question of the current round that `page`'s user may answer. */
async function answerRound(page: Page, round: string) {
  await page.goto(grillingTab);
  const current = page.locator('#current-round');
  await expect(current.getByRole('heading', { name: new RegExp(`^${round} round`) })).toBeVisible();
  const boxes = current.getByRole('textbox');
  let open = await boxes.count();
  expect(open).toBeGreaterThan(0);
  while (open > 0) {
    const question = current
      .getByRole('listitem')
      .filter({ has: page.getByRole('textbox') })
      .first();
    await question.getByRole('textbox').fill(`${round} answer ${open}`);
    await question.getByRole('button', { name: 'Answer' }).click();
    open -= 1;
    await expect(boxes).toHaveCount(open, { timeout: 15_000 });
  }
}

test('Grilling → approve the Brief → accept a Feature Suggestion → approve its Spec', async ({
  as,
}) => {
  // Pim (PO, Admin) starts a Grilling: business questions for POs, then UX, then technical.
  const po = await as(pim);
  await po.goto(grillingTab);
  await po.getByRole('button', { name: 'Start Grilling' }).click();
  await expect(po.getByRole('heading', { name: /^Current Grilling: Running/ })).toBeVisible();

  await answerRound(po, 'Business');
  await answerRound(await as(fern), 'UX');
  await answerRound(await as(oak), 'Technical');

  // The AI drafts a Brief Proposal from the answers; Pim, who started it, approves it.
  await po.goto(grillingTab);
  const proposal = po.locator('#brief-proposal');
  await expect(
    proposal.getByRole('heading', { name: 'Proposed Project Brief change' }),
  ).toBeVisible();
  await expect(proposal.getByText('Added: ## From Grilling')).toBeVisible();
  await proposal.getByRole('button', { name: 'Approve Brief change' }).click();
  await expect(po.getByText(/^Project Brief v\d+ approved\./)).toBeVisible();
  await expect(po.getByRole('heading', { name: 'From Grilling' })).toBeVisible();

  // The AI suggests Features from the Brief; Pim accepts one into the Checkout Team.
  await po.goto(`/projects/${SEED.projectId}?tab=suggestions`);
  await po.getByLabel('How many').fill('2');
  await po.getByRole('button', { name: 'Generate Feature Suggestions' }).click();
  const pending = po.getByRole('region', { name: /^Waiting for a decision/ });
  const suggestion = pending.getByRole('listitem').first();
  await expect(suggestion).toBeVisible();
  const title = (await suggestion.getByRole('heading').textContent()) ?? '';
  expect(title).toMatch(/^Suggested Feature \d+$/);
  await suggestion.getByLabel('Team').selectOption({ label: 'Checkout' });
  await suggestion.getByRole('button', { name: 'Accept' }).click();

  // Accepting creates the Feature with a first Spec Proposal, which Pim approves.
  await expect(po).toHaveURL(/\/features\/[0-9a-f-]{36}\/proposals\/[0-9a-f-]{36}$/);
  await expect(po.getByRole('heading', { name: 'Proposed Spec change' })).toBeVisible();
  await po.getByRole('button', { name: 'Approve Spec change' }).click();
  await expect(po).toHaveURL(/\/features\/[0-9a-f-]{36}\?approved=1$/);
  await expect(po.getByText('Spec v1 approved.', { exact: false })).toBeVisible();
  // The Feature's title, then the same title as the Spec's own heading.
  await expect(po.getByRole('heading', { level: 1, name: title }).first()).toBeVisible();
});
