import { beam, expect, mint, pim, SEED, test, unique } from './fixtures';

test('raise → send to all POs → Claim → ask for info → answer → decide → approve the Spec Proposal', async ({
  as,
}) => {
  const title = unique('Keep the cart after a failed payment?');

  // Beam (Backend) raises a Blocker; the fake AI drafts Choices and suggests the PO decides.
  const raiser = await as(beam);
  await raiser.goto(`/features/${SEED.featureId}/raise`);
  await raiser.getByLabel('Title').fill(title);
  await raiser.getByLabel('Description').fill('A failed payment empties the cart today.');
  await raiser.getByRole('button', { name: 'Continue to review' }).click();
  await expect(raiser).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestUrl = new URL(raiser.url()).pathname;

  // The Feature has two PO Role Owners: by default it goes to both, the first to Claim decides.
  await expect(raiser.getByLabel('All 2 POs. The first to Claim it decides.')).toBeChecked();
  await raiser.getByRole('button', { name: 'Send now' }).click();
  await expect(raiser.getByText('Waiting for a decision')).toBeVisible();
  await expect(raiser.getByText(/sent to (Pim and Mint|Mint and Pim)\./)).toBeVisible();

  // Both POs see it as a request to Claim.
  const otherPo = await as(pim);
  await otherPo.goto('/inbox');
  await expect(
    otherPo.getByRole('region', { name: /Sent to you, not Claimed yet/ }).getByText(title),
  ).toBeVisible();

  const decider = await as(mint);
  await decider.goto('/inbox');
  await decider
    .getByRole('region', { name: /Sent to you, not Claimed yet/ })
    .getByRole('link')
    .filter({ hasText: title })
    .click();
  await expect(decider).toHaveURL(requestUrl);

  // Mint Claims it and becomes the Decider; it leaves Pim's Inbox.
  await decider.getByRole('button', { name: 'Claim it' }).click();
  await expect(decider.getByText(/for Mint to decide\./)).toBeVisible();
  await otherPo.reload();
  await expect(otherPo.getByText(`“${title}” was Claimed.`)).toBeVisible();
  await expect(
    otherPo.getByRole('region', { name: /Sent to you, not Claimed yet/ }).getByText(title),
  ).toHaveCount(0);

  // The Decider asks for more info: the request waits for the Raiser.
  await decider.getByLabel('Ask the Raiser for more info').fill('Which provider errors count?');
  await decider.getByRole('button', { name: 'Ask for more info' }).click();
  await expect(decider.getByText('Waiting for more info', { exact: true })).toBeVisible();

  // Beam finds the question in his Inbox and answers it.
  await raiser.goto('/inbox');
  await raiser
    .getByRole('region', { name: /The Decider needs more info/ })
    .getByRole('link')
    .filter({ hasText: title })
    .click();
  await expect(raiser).toHaveURL(requestUrl);
  await expect(raiser.getByText('Which provider errors count?')).toBeVisible();
  await raiser.getByLabel('Your answer').fill('Declines and timeouts, not network errors.');
  await raiser.getByRole('button', { name: 'Send answer' }).click();
  await expect(raiser.getByText('Waiting for a decision', { exact: true })).toBeVisible();

  // Mint picks Choice A. The AI drafts the Spec change, which the Decider approves.
  await decider.reload();
  await expect(decider.getByText('Declines and timeouts, not network errors.')).toBeVisible();
  await decider.getByText(`Option A for "${title}"`).click();
  await decider.getByRole('button', { name: /^Decide A: / }).click();
  await expect(decider.getByRole('heading', { name: 'Proposed Spec change' })).toBeVisible();
  await expect(decider.getByText('Decided by Mint')).toBeVisible();
  await decider.getByRole('button', { name: 'Approve Spec change' }).click();

  await expect(decider).toHaveURL(new RegExp(`/features/${SEED.featureId}\\?approved=\\d+$`));
  await expect(decider.getByText(/^Spec v\d+ approved\./)).toBeVisible();
  await expect(decider.getByRole('heading', { name: 'Decisions' })).toBeVisible();
  await expect(decider.getByText(new RegExp(`${title.replace(/[()?]/g, '\\$&')}: `))).toBeVisible();

  // The Raiser sees it decided and the Spec updated.
  await raiser.reload();
  await expect(raiser.getByText('Decided and Spec updated')).toBeVisible();
});
