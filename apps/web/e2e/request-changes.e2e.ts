import type { APIRequestContext } from '@playwright/test';
import type { DecisionRequestView, SpecVersionView } from '@vorasaan/shared';
import { E2E } from './env';
import { beam, chooseOption, expect, pim, SEED, test, unique } from './fixtures';

// Request changes and Redrafts (ticket 0065), against the real server with VORASAAN_AI=fake:
// the fake's Redraft of a Markdown proposal adds "- Changed as asked: <feedback>", and its
// Redraft of Choices retitles the Choice pointed at "<title> (redraft N)".

const asPim = { 'x-vorasaan-user': pim.id };
const words = (text: string) =>
  (text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text' as const, delta }));

async function latestSpec(request: APIRequestContext) {
  const res = await request.get(`${E2E.apiUrl}/features/${SEED.featureId}/spec-versions`, {
    headers: asPim,
  });
  const versions = (await res.json()) as SpecVersionView[];
  return versions.reduce((a, v) => (v.version > a.version ? v : a));
}

test('Request changes on a Spec Proposal card: Redraft 2, its diff, then approve it', async ({
  as,
  request,
}) => {
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);
  const current = await latestSpec(request);
  const marker = unique('Treat a payment as failed after 24 hours');
  const res = await request.post(`${E2E.apiUrl}/dev/fake-ai/chat-script`, {
    headers: asPim,
    data: {
      replies: [
        {
          chunks: [
            ...words('I drafted the change. '),
            {
              type: 'tool-call',
              call: {
                id: 'e2e-redraft',
                name: 'draftSpecProposal',
                args: {
                  proposedMarkdown: `${current.markdown.trimEnd()}\n\n## Timeouts\n- ${marker}\n`,
                  summary: 'Adds a payment timeout.',
                },
              },
            },
          ],
        },
        { chunks: words('Approve it when it reads right.') },
      ],
    },
  });
  expect(res.status()).toBe(204);
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Add a payment timeout to the Spec');
  await message.press('Enter');

  const card = page.getByRole('article', { name: 'Change the Spec of "Async checkout"' });
  await expect(card).toContainText(marker);
  // The reply has finished: the card won't be redrawn under the form.
  await expect(page.getByText('Approve it when it reads right.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  // ...and the Conversation has its own URL, so the view won't be drawn again.
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);

  // Request changes, pointing at the new section.
  const form = card.getByRole('form', { name: 'Request changes' });
  await expect(async () => {
    if (!(await form.isVisible()))
      await card.getByRole('button', { name: 'Request changes' }).click();
    await expect(form).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const feedback = unique('Also email the customer when it fails');
  await form.getByLabel('What should the AI change?').fill(feedback);
  await chooseOption(form, 'About', 'Section: Timeouts');
  await form.getByRole('button', { name: 'Ask for a Redraft' }).click();

  // Redraft 2 is shown, in the same card, still waiting for approval.
  await expect(card).toContainText('Redraft 2');
  await expect(card).toContainText(`Changed as asked: ${feedback}`);
  await expect(card).toContainText('Proposed');
  await expect(form).toHaveCount(0);

  // Its diff from Redraft 1, with the feedback that caused it.
  await card.getByRole('button', { name: 'Compare Redrafts' }).click();
  const redrafts = card.getByRole('group', { name: 'Redrafts' });
  await expect(redrafts.getByRole('button', { name: 'Redraft 2 (current)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card).toContainText(`Pim asked about the section “Timeouts”: ${feedback}`);
  const diff = card.getByRole('figure', { name: 'Changes from Redraft 1 to Redraft 2' });
  await expect(diff).toContainText('1 added, 0 removed');
  await expect(diff).toContainText(`Changed as asked: ${feedback}`);

  // Approve applies Redraft 2.
  await card.getByRole('button', { name: 'Approve Redraft 2' }).click();
  await expect(card).toContainText(`Approved · Spec v${current.version + 1}`);
  const after = await latestSpec(request);
  expect(after.version).toBe(current.version + 1);
  expect(after.markdown).toContain(marker);
  expect(after.markdown).toContain(`Changed as asked: ${feedback}`);
});

test('Request changes on Choices, pointing at one: the Raiser sees Redraft 2 before sending', async ({
  as,
  request,
}) => {
  const title = unique('Which provider status counts as failed?');
  const raiser = await as(beam);
  await raiser.goto(`/features/${SEED.featureId}/raise`);
  await raiser.getByLabel('Title').fill(title);
  await raiser.getByLabel('Description').fill('The provider reports five statuses.');
  await raiser.getByRole('button', { name: 'Continue to review' }).click();
  await expect(raiser).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const id = new URL(raiser.url()).pathname.split('/').at(-1) as string;

  const section = raiser.getByRole('region', { name: 'Redrafts of the Choices' });
  await section.getByRole('button', { name: 'Request changes' }).click();
  await section
    .getByLabel('What should the AI change?')
    .fill('B should keep the old status codes.');
  await chooseOption(section, 'About', `Choice B: Option B for "${title}"`);
  await section.getByRole('button', { name: 'Ask for a Redraft' }).click();

  await expect(section.getByRole('button', { name: 'Redraft 2 (current)' })).toBeVisible();
  await expect(section).toContainText(
    'Beam asked about Choice B: B should keep the old status codes.',
  );
  const diff = section.getByRole('figure', { name: 'Changes from Redraft 1 to Redraft 2' });
  await expect(diff).toContainText(`B. Option B for "${title}" (redraft 2)`);
  // Redraft 1 is still there to look at.
  await section.getByRole('button', { name: 'Redraft 1', exact: true }).click();
  await expect(section).toContainText('The proposal as the AI first drafted it.');

  // Sending sends Redraft 2's Choices.
  await raiser.getByRole('button', { name: 'Send now' }).click();
  await expect(raiser.getByText('Waiting for a decision')).toBeVisible();
  const sent = await request.get(`${E2E.apiUrl}/decision-requests/${id}`, { headers: asPim });
  const body = (await sent.json()) as DecisionRequestView;
  expect(body.choices.map((c) => c.title)).toEqual([
    `Option A for "${title}"`,
    `Option B for "${title}" (redraft 2)`,
    `Option C for "${title}"`,
  ]);
});
