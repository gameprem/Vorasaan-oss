import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import type { ConversationTurnView, ConversationUsage, ConversationView } from '@vorasaan/shared';
import { E2E } from './env';
import { expect, pim, SEED, test, unique } from './fixtures';

// Chat history like a chat app, the context meter and /compact (ticket 0066). A long
// Conversation opens on its latest page at the bottom and loads older pages as the person
// scrolls up, without the view jumping; a compaction is a thin divider with the messages
// above it still there to read; the meter under the composer follows each turn.

const asPim = { 'x-vorasaan-user': pim.id };
const shots = process.env.E2E_SCREENSHOTS_DIR;

/** A Conversation of `count` stored messages, "History message 0" first. */
function longConversation(count: number): string {
  return execFileSync(
    'bun',
    [
      fileURLToPath(new URL('./seed-long-conversation.ts', import.meta.url)),
      String(count),
      unique('A long chat'),
    ],
    { env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, encoding: 'utf8' },
  ).trim();
}

/** How far the thread is from its bottom, in px. */
const fromBottom = (thread: Locator) =>
  thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Scrolls the thread to its top and says where `text`'s message was just then. */
const toTop = (thread: Locator, text: string) =>
  thread.evaluate((el, t) => {
    el.scrollTop = 0;
    const m = [...el.querySelectorAll('.msg')].find((n) => n.textContent?.includes(t));
    return m?.getBoundingClientRect().top ?? Number.NaN;
  }, text);

/** Where a message sits in the window, in px from the top. */
const topOf = (page: Page, text: string) =>
  page
    .locator('.msg', { hasText: text })
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);

test('a 300-message Conversation opens at the bottom and loads older pages without jumping', async ({
  as,
  request,
}) => {
  const id = longConversation(300);
  const page = await as(pim);
  await page.goto(`/conversations/${id}`);
  const log = page.getByRole('log', { name: 'Messages' });
  const thread = page.locator('.chat-thread');

  // The latest page (50 messages), scrolled to the bottom.
  await expect(log.getByText('History message 299:')).toBeInViewport();
  await expect(log.getByText('History message 250:')).toBeAttached();
  await expect(log.getByText('History message 249:')).toHaveCount(0);
  await expect.poll(() => fromBottom(thread)).toBeLessThan(5);

  // Scrolling to the top loads the page before, with a skeleton while it loads; what was
  // on screen stays where it was, to the pixel or so. The first page is held back a moment
  // so the skeleton can be seen.
  const older = /\/api\/conversations\/[^/]+\/messages\?before=/;
  await page.route(older, async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.continue();
  });
  for (let oldest = 250; oldest > 0; oldest -= 50) {
    const text = `History message ${oldest}:`;
    const before = await toTop(thread, text);
    if (oldest === 250) {
      await expect(page.locator('.older-loading [aria-hidden]').first()).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/loading-older-messages.png` });
    }
    await expect(log.getByText(`History message ${oldest - 50}:`)).toBeAttached();
    if (oldest === 250) await page.unroute(older);
    await expect(page.locator('.older-loading [aria-hidden]')).toHaveCount(0);
    expect(Math.abs((await topOf(page, text)) - before)).toBeLessThan(4);
  }
  await expect(log.getByText('History message 0:')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  // Every message is there once.
  await expect(page.locator('.msg[data-message-id]')).toHaveCount(300);

  // Reading further up, a new message shows "↓ New messages"; it scrolls to the bottom.
  await log.getByText('History message 100:').scrollIntoViewIfNeeded();
  const sent = await request.post(`${E2E.apiUrl}/conversations/${id}/messages`, {
    headers: asPim,
    data: { content: 'A message from another tab' },
  });
  expect(sent.status()).toBe(201);
  const pill = page.getByRole('button', { name: '↓ New messages' });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(log.getByText('A message from another tab').first()).toBeInViewport();
  await expect(pill).toHaveCount(0);

  // Compacting draws a divider; the 300 messages above it are still there, not dimmed.
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('/compact');
  await input.press('Enter');
  const divider = log.locator('.compaction-divider');
  await expect(divider).toBeVisible();
  await expect(divider).toContainText('↑ The AI reads the messages above as a summary');
  await expect(page.locator('.msg[data-message-id]')).toHaveCount(302); // the other tab’s message and its reply
  const old = log.locator('.msg', { hasText: 'History message 298:' });
  await expect(old).toBeVisible();
  await expect(old).toHaveCSS('opacity', '1');
});

test('a deep link opens the page around a message and loads both ways', async ({ as, request }) => {
  const id = longConversation(300);
  const around = await request.get(`${E2E.apiUrl}/conversations/${id}/messages?limit=1`, {
    headers: asPim,
  });
  const latest = (await around.json()) as { olderCursor: string };
  expect(latest.olderCursor).toBeTruthy();
  const view = (await (
    await request.get(`${E2E.apiUrl}/conversations/${id}?limit=100`, { headers: asPim })
  ).json()) as ConversationView;
  const target = view.messages.find((m) => m.content.startsWith('History message 220:'));
  if (!target) throw new Error('no message 220');

  const page = await as(pim);
  await page.goto(`/conversations/${id}?message=${target.id}`);
  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log.locator(`[data-message-id="${target.id}"]`)).toBeInViewport();
  await expect(log.getByText('History message 299:')).toHaveCount(0);
  // Down to the latest, and up from there.
  const thread = page.locator('.chat-thread');
  await expect(async () => {
    await thread.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(log.getByText('History message 299:')).toBeAttached({ timeout: 1000 });
  }).toPass();
  await expect(async () => {
    await thread.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(log.getByText('History message 190:')).toBeAttached({ timeout: 1000 });
  }).toPass();
});

test('the context meter follows each turn; /compact draws a divider and View summary shows it', async ({
  as,
  request,
}) => {
  const started = await request.post(`${E2E.apiUrl}/conversations`, {
    headers: asPim,
    data: {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content: unique('How long may a payment stay pending'),
    },
  });
  expect(started.status()).toBe(201);
  const { id } = (await started.json()) as ConversationView;
  const turn = await request.post(`${E2E.apiUrl}/conversations/${id}/messages`, {
    headers: asPim,
    data: { content: 'What does support see while it is pending' },
  });
  expect(turn.status()).toBe(201);
  const { usage } = (await turn.json()) as ConversationTurnView;
  expect(usage).not.toBeNull();

  const page = await as(pim);
  await page.goto(`/conversations/${id}`);
  const log = page.getByRole('log', { name: 'Messages' });
  const meter = page.getByRole('button', { name: /^Context: / });
  await expect(meter).toBeVisible();
  const label = (await meter.getAttribute('aria-label')) ?? '';
  const percent = Math.round((usage as ConversationUsage).history.fraction * 100);
  expect(label).toContain(`Context: ${percent}% of the history share used`);
  expect(label).toMatch(/It compacts at 70%/);

  // Hovering shows the shares, the Context Window and the last turn's cache reads.
  // (Before the page has hydrated a hover does nothing, so hover again until it shows.)
  const tip = page.getByRole('tooltip');
  await expect(async () => {
    await page.mouse.move(0, 0);
    await meter.hover();
    await expect(tip).toBeVisible({ timeout: 1500 });
  }).toPass();
  await expect(tip).toContainText('Context Window');
  await expect(tip).toContainText('Last turn read from cache');
  await expect(tip).toContainText('Retrieved context');
  if (shots) await page.screenshot({ path: `${shots}/context-meter-hover.png` });
  await page.mouse.move(0, 0);

  // A turn in the browser updates it live.
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('And when does it time out, after how many minutes');
  await input.press('Enter');
  await expect(log.getByText('And when does it time out').first()).toBeVisible();
  await expect(page.getByText('Vorasaan is thinking…')).toHaveCount(0);
  await expect.poll(async () => meter.getAttribute('aria-label')).not.toBe(label);

  // /compact with what to keep: the history folds, a divider marks it, the messages stay.
  await input.fill('/compact keep the timeout rules');
  await input.press('Enter');
  const divider = log.locator('.compaction-divider');
  await expect(divider).toBeVisible();
  await expect(divider).toContainText('↑ The AI reads the messages above as a summary');
  await expect(log.getByText('How long may a payment stay pending').first()).toBeVisible();
  await expect(log.locator('.msg.user', { hasText: 'How long may a payment' })).toHaveCSS(
    'opacity',
    '1',
  );
  await expect(page.getByText('Compacted', { exact: true })).toBeVisible();

  // View summary: the Conversation Summary as that compaction left it.
  await divider.getByRole('button', { name: 'View summary' }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation Summary' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Agreed' })).toBeVisible();
  await expect(dialog).toContainText('Keep: keep the timeout rules');
  await expect(dialog).toContainText('keeping “keep the timeout rules”');
  await expect(page.locator('[data-entering]')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/divider-view-summary.png` });
  await dialog.getByRole('button', { name: 'Close' }).click();

  // "Compact now" from the meter's panel compacts again: one divider per compaction.
  await input.fill('One more question about refunds');
  await input.press('Enter');
  await expect(page.getByText('Vorasaan is thinking…')).toHaveCount(0);
  await expect(log.getByText('One more question about refunds').first()).toBeVisible();
  await meter.click();
  await page.getByRole('button', { name: 'Compact now' }).click();
  await expect(divider).toHaveCount(2);
});

test('the meter warns near the compaction threshold of the Conversation’s model', async ({
  as,
  request,
}) => {
  // On the default model's window (its history share is 32,000 tokens, compacting at 70%),
  // one long Thai message of about 20,000 tokens is past the warning, before compacting.
  const sentence = 'ลูกค้ากดชำระเงินแล้วระบบต้องแสดงสถานะกำลังดำเนินการทันทีโดยไม่ต้องรอผู้ให้บริการ';
  const lines = [unique('Thai notes')];
  while (lines.join('\n').length + sentence.length < 19_200) lines.push(sentence);
  const started = await request.post(`${E2E.apiUrl}/conversations`, {
    headers: asPim,
    data: { scope: { kind: 'FEATURE', featureId: SEED.featureId }, content: lines.join('\n') },
  });
  expect(started.status()).toBe(201);
  const { id } = (await started.json()) as ConversationView;
  const usage = (await (
    await request.get(`${E2E.apiUrl}/conversations/${id}/usage`, { headers: asPim })
  ).json()) as ConversationUsage;
  expect(usage.history.used).toBeGreaterThanOrEqual(usage.history.warnAt);
  expect(usage.history.used).toBeLessThan(usage.history.compactAt);

  const page = await as(pim);
  await page.goto(`/conversations/${id}`);
  const meter = page.getByRole('button', { name: /^Context: / });
  await expect(meter).toHaveAttribute('data-level', 'warn');
  await expect(meter).toHaveAttribute('aria-label', /Compaction is near\./);
});
