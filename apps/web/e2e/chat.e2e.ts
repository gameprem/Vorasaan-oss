import type { APIRequestContext } from '@playwright/test';
import type { SpecVersionView } from '@vorasaan/shared';
import { E2E } from './env';
import { expect, pim, SEED, test, unique } from './fixtures';

// The chat view (ticket 0046) against the real server with VORASAAN_AI=fake. The fake AI's
// next replies are scripted through the dev-only POST /dev/fake-ai/chat-script, which
// exists only with the fake AI and dev sign-in.

type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; args: unknown } };
type Reply = { chunks: Chunk[]; chunkDelayMs?: number; error?: string };

const asPim = { 'x-vorasaan-user': pim.id };
const words = (text: string): Chunk[] =>
  (text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text', delta }));
const toolCall = (id: string, name: string, args: unknown): Chunk => ({
  type: 'tool-call',
  call: { id, name, args },
});

async function scriptChat(request: APIRequestContext, ...replies: Reply[]) {
  const res = await request.post(`${E2E.apiUrl}/dev/fake-ai/chat-script`, {
    headers: asPim,
    data: { replies },
  });
  expect(res.status()).toBe(204);
}

async function latestSpec(request: APIRequestContext) {
  const res = await request.get(`${E2E.apiUrl}/features/${SEED.featureId}/spec-versions`, {
    headers: asPim,
  });
  const versions = (await res.json()) as SpecVersionView[];
  return versions.reduce((a, v) => (v.version > a.version ? v : a));
}

test('a Feature Conversation streams its reply as it is written', async ({ as, request }) => {
  const page = await as(pim);
  await page.goto('/conversations/new');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pim');

  // Picking the Feature turns the starters into chips.
  await page.getByLabel('Project or Feature').selectOption({ label: 'Async checkout' });
  await expect(page.getByRole('button', { name: 'Raise a Blocker' })).toBeVisible();

  const reply = 'Payments wait for the provider for up to 24 hours, then they fail.';
  await scriptChat(request, { chunks: words(reply), chunkDelayMs: 250 });
  const question = unique('How long do payments wait?');
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill(question);
  await message.press('Enter');

  // The reply shows as it streams, announced politely, with Stop on offer meanwhile.
  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log).toHaveAttribute('aria-live', 'polite');
  await expect(log).toContainText('Payments wait for');
  await expect(log).not.toContainText('they fail.');
  await expect(page.getByRole('button', { name: 'Stop the reply' })).toBeVisible();

  await expect(log).toContainText(reply);
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(log.getByText(question)).toBeVisible();

  // It is a recent Conversation now, and the Feature is selected in the Sidebar.
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByRole('link').filter({ hasText: question })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /^Async checkout/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('an Action Card from a tool call: Approve, and the panel shows the new Spec Version', async ({
  as,
  request,
}) => {
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);

  const current = await latestSpec(request);
  const marker = unique('Treat a payment as failed after 24 hours');
  const proposed = `${current.markdown.trimEnd()}\n\n## Timeouts\n- ${marker}\n`;
  await scriptChat(
    request,
    {
      chunks: [
        ...words('I drafted the change. '),
        toolCall('e2e-spec', 'draftSpecProposal', {
          proposedMarkdown: proposed,
          summary: 'Adds a payment timeout.',
        }),
      ],
    },
    { chunks: words('Approve it when it reads right.') },
  );
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Add a payment timeout to the Spec');
  await message.press('Enter');

  const card = page.getByRole('article', { name: 'Change the Spec of "Async checkout"' });
  await expect(card).toContainText('Proposed');
  await expect(card).toContainText(marker);
  await expect(card).toContainText(`Approving writes Spec v${current.version + 1}`);
  await expect(page.getByText('Drafted a Spec Proposal')).toBeVisible();

  // The Spec is open beside the chat, with the pending change on top.
  const panel = page.getByRole('complementary', { name: 'Spec' });
  await expect(panel).toContainText(`v${current.version} · approved by`);
  await expect(panel).toContainText('Proposed change');

  await card.getByRole('button', { name: 'Approve Spec change' }).click();
  await expect(card).toContainText(`Approved · Spec v${current.version + 1}`);
  await expect(card.getByRole('button', { name: 'Approve Spec change' })).toHaveCount(0);
  await expect(panel).toContainText(`v${current.version + 1} · approved by Pim`);
  await expect(panel).not.toContainText('Proposed change');
  await expect(panel.locator('.doc-md')).toContainText(marker);
  await expect(page.getByRole('button', { name: `Spec v${current.version + 1}` })).toBeVisible();

  // The panel closes and opens again from the header.
  await panel.getByRole('button', { name: 'Close the Spec panel' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: `Spec v${current.version + 1}` }).click();
  await expect(page.getByRole('complementary', { name: 'Spec' })).toBeVisible();
});

test('Stop keeps what the AI wrote so far', async ({ as, request }) => {
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);
  await scriptChat(request, {
    chunks: words('One two three four five six seven eight nine ten eleven twelve.'),
    chunkDelayMs: 300,
  });
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Count to twelve, slowly');
  await message.press('Enter');
  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log).toContainText('One two');
  await page.getByRole('button', { name: 'Stop the reply' }).click();

  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  await expect(log).toContainText('One two');
  await expect(log).not.toContainText('twelve.');
  // Still not finished after a while: it really stopped.
  await page.waitForTimeout(1_000);
  await expect(log).not.toContainText('twelve.');
});

test('after a failed reply, Retry asks again without sending the message twice', async ({
  as,
  request,
}) => {
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);
  // The first message gets its reply; the second one's reply fails mid-stream.
  await scriptChat(
    request,
    { chunks: words('Hello again.') },
    { chunks: words('Half of a'), error: 'The provider dropped the connection' },
    { chunks: words('The whole answer, this time.') },
  );
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Hello');
  await message.press('Enter');
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  await message.fill('Tell me about the timeouts');
  await message.press('Enter');

  const log = page.getByRole('log', { name: 'Messages' });
  await expect(page.getByRole('alert').filter({ hasText: 'The AI failed' })).toBeVisible();
  await expect(log).not.toContainText('Half of a');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(log).toContainText('The whole answer, this time.');
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(log.getByText('Tell me about the timeouts')).toHaveCount(1);
});

test('cards work with the keyboard alone: dismiss a Feature Suggestion with a reason', async ({
  as,
  request,
}) => {
  const page = await as(pim);
  await page.goto(`/conversations/new?project=${SEED.projectId}`);
  await scriptChat(
    request,
    { chunks: [toolCall('e2e-suggest', 'suggestFeatures', { count: 1 })] },
    { chunks: words('Here is one idea.') },
  );
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.focus();
  await page.keyboard.type('Suggest a Feature');
  await page.keyboard.press('Enter');

  const card = page.getByRole('article').filter({ hasText: 'Feature Suggestion' });
  await expect(card).toContainText('Proposed');
  // A Project Conversation has the Project Brief beside it.
  await expect(page.getByRole('complementary', { name: 'Project Brief' })).toBeVisible();

  // Focus the card's Dismiss, then answer with the keyboard alone.
  const dismiss = card.getByRole('button', { name: 'Dismiss' });
  await message.focus();
  for (let i = 0; i < 10; i++) {
    if (await dismiss.evaluate((b) => b === document.activeElement)) break;
    await page.keyboard.press('Shift+Tab');
  }
  await expect(dismiss).toBeFocused();
  await page.keyboard.press('Enter');
  const reason = card.getByRole('textbox', { name: 'Why dismiss it?' });
  await expect(reason).toBeFocused();
  await page.keyboard.type('We already have this on the roadmap');
  await page.keyboard.press('Enter');
  await expect(card).toContainText('Declined · dismissed');
  await expect(card).toContainText('Dismissed because: We already have this on the roadmap');
});

test('Settings over a Conversation keeps its composer draft', async ({ as }) => {
  const page = await as(pim);
  // The Sidebar opens the Feature's latest Conversation.
  await page.goto('/inbox');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await sidebar.getByRole('button', { name: 'Show the Features of Mobile Banking' }).click();
  await sidebar.getByRole('link', { name: /^Async checkout/ }).click();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);

  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('A draft I am still writing');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(message).toHaveValue('A draft I am still writing');

  // The header links to the Feature's own page.
  await page
    .getByRole('navigation', { name: 'Where this Conversation belongs' })
    .getByRole('link', { name: 'Async checkout' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/features/${SEED.featureId}$`));
});

test('an unknown URL is a 404', async ({ as }) => {
  const page = await as(pim);
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: "That page doesn't exist" })).toBeVisible();
});
