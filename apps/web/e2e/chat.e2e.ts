import type { APIRequestContext } from '@playwright/test';
import type { SpecVersionView } from '@vorasaan/shared';
import { E2E } from './env';
import { expect, pim, SEED, searchAndChoose, test, unique } from './fixtures';

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
  await searchAndChoose(page, 'Project or Feature', 'Async', 'Async checkout');
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

// ─── The model picker (ticket 0054) ─────────────────────────────────────────

/** Where to save the ticket's screenshots, when asked (E2E_SCREENSHOT_DIR). */
const shots = process.env.E2E_SCREENSHOT_DIR;
const shot = (name: string) => (shots ? { path: `${shots}/${name}` } : {});

/** Two fake Approved Models on one provider: "Best" (the default) and "Fast". */
async function twoApprovedModels(request: APIRequestContext) {
  const listed = await request.get(`${E2E.apiUrl}/settings/ai/models`, { headers: asPim });
  expect(listed.status()).toBe(200);
  const { models } = (await listed.json()) as { models: { displayName: string }[] };
  if (models.some((m) => m.displayName === 'Fast')) return;
  const provider = await request.post(`${E2E.apiUrl}/settings/ai/providers`, {
    headers: asPim,
    data: { kind: 'ANTHROPIC', name: 'Fake provider', apiKey: 'sk-e2e-not-a-real-key' },
  });
  expect(provider.status()).toBe(201);
  const providerId = ((await provider.json()) as { id: string }).id;
  for (const [modelId, displayName, note] of [
    ['fake-best', 'Best', 'Specs, Choices and hard calls'],
    ['fake-fast', 'Fast', 'Quick answers and summaries'],
  ]) {
    const res = await request.post(`${E2E.apiUrl}/settings/ai/models`, {
      headers: asPim,
      data: { providerId, modelId, displayName, note },
    });
    expect(res.status()).toBe(201);
  }
}

test('the model picker: picking "Fast" shows "Fast" under the next reply, and a reload keeps it', async ({
  as,
  request,
}) => {
  await twoApprovedModels(request);
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);
  const message = page.getByRole('textbox', { name: 'Message' });
  const log = page.getByRole('log', { name: 'Messages' });
  const labels = page.locator('.msg.ai .by');

  // A new Conversation runs on the default.
  const picker = page.getByRole('button', { name: 'Model: Best' });
  await expect(picker).toBeVisible();
  await scriptChat(request, { chunks: words('The first answer, on the default.') });
  await message.fill(unique('Which model answers first?'));
  await message.press('Enter');
  await expect(log).toContainText('The first answer, on the default.');
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  await expect(labels).toHaveCount(1);
  await expect(labels.first()).toContainText('Best');

  // The menu: every Approved Model with its note, the current one ticked.
  await picker.click();
  const menu = page.getByRole('menu', { name: 'Models your Admin approved' });
  await expect(menu).toBeVisible();
  const bestItem = menu.getByRole('menuitemradio', { name: /Best/ });
  const fastItem = menu.getByRole('menuitemradio', { name: /Fast/ });
  await expect(bestItem).toHaveAttribute('aria-checked', 'true');
  await expect(fastItem).toHaveAttribute('aria-checked', 'false');
  await expect(menu).toContainText('Quick answers and summaries');
  await expect(bestItem).toBeFocused();
  await page.screenshot(shot('menu-open.png'));

  // Esc closes it and gives focus back; the keyboard alone picks "Fast".
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(bestItem).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(fastItem).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Model: Fast' })).toBeFocused();

  // It applies from the next message; the earlier reply keeps its model.
  await scriptChat(request, { chunks: words('The second answer, on Fast.') });
  await message.fill('And now, quickly?');
  await message.press('Enter');
  await expect(log).toContainText('The second answer, on Fast.');
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(0)).toContainText('Best');
  await expect(labels.nth(1)).toContainText('Fast');
  await page.screenshot(shot('reply-model-label.png'));

  // A reload keeps both, and the Conversation's model.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Model: Fast' })).toBeVisible();
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(1)).toContainText('Fast');

  // On a phone the menu spans the composer and nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Model: Fast' }).click();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot(shot('phone-menu.png'));
});

test('a Spec change drafted on "Fast" shows "Drafted with Fast" in the Spec history', async ({
  as,
  request,
}) => {
  await twoApprovedModels(request);
  const page = await as(pim);
  await page.goto(`/conversations/new?feature=${SEED.featureId}`);
  await page.getByRole('button', { name: /^Model: / }).click();
  await page.getByRole('menuitemradio', { name: /Fast/ }).click();
  await expect(page.getByRole('button', { name: 'Model: Fast' })).toBeVisible();

  const current = await latestSpec(request);
  const marker = unique('Retry a failed payment once');
  await scriptChat(
    request,
    {
      chunks: [
        toolCall('e2e-fast-spec', 'draftSpecProposal', {
          proposedMarkdown: `${current.markdown.trimEnd()}\n\n## Retries\n- ${marker}\n`,
          summary: 'Retry a failed payment once.',
        }),
      ],
    },
    { chunks: words('Approve it when it reads right.') },
  );
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Add a retry to the Spec');
  await message.press('Enter');
  const card = page.getByRole('article', { name: 'Change the Spec of "Async checkout"' });
  await card.getByRole('button', { name: 'Approve Spec change' }).click();
  await expect(card).toContainText(`Approved · Spec v${current.version + 1}`);

  await page.goto(`/features/${SEED.featureId}?tab=history`);
  const entry = page
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`^v${current.version + 1}\\D`) });
  await expect(entry).toContainText('Drafted with Fast');
  await page.screenshot(shot('spec-history-drafted-with.png'));
});
