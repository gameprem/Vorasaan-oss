import type { Page } from '@playwright/test';
import { expect, fern, mint, oak, pim, SEED, test } from './fixtures';

const grillingTab = `/projects/${SEED.projectId}?tab=grilling`;

/** Where to save the ticket's screenshots, when asked (E2E_SCREENSHOT_DIR). */
const shots = process.env.E2E_SCREENSHOT_DIR;
const shot = (name: string) => (shots ? { path: `${shots}/${name}` } : {});

/** Long enough that the fake AI asks no follow-up. */
const FULL = (n: number) => `A complete answer number ${n} with plenty of detail.`;

/** Answers every open question of the current round on the Grilling form (the fallback). */
async function answerRoundOnTheForm(page: Page, round: string) {
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

/** Opens the user's Grilling Conversation from their Inbox Item "Answer Grilling". */
async function openFromInbox(page: Page, round: string, role: string) {
  await page.goto('/inbox');
  await page
    .getByRole('link', { name: new RegExp(`${round} round: \\d+ questions? for ${role}`) })
    .click();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('list', { name: 'Grilling rounds' })).toBeVisible();
}

/** Sends a message and waits for the server's reply to end with `expected`. */
async function answer(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('.msg.user .bubble').last()).toHaveText(text);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
}

/** Scrolls the thread to its top, where the round header is. */
const toTop = (page: Page) =>
  page.locator('.chat-thread').evaluate((el) => {
    el.scrollTop = 0;
  });

/** The round header's entry for a round, e.g. "Business · PO". */
const roundIn = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Grilling rounds' }).getByRole('listitem').filter({
    hasText: name,
  });

test('Grilling in chat → approve the Brief from its card → accept a Feature Suggestion → approve its Spec', async ({
  as,
  browser,
  baseURL,
}) => {
  // Pim (PO, Admin) starts a Grilling: business questions for POs, then UX, then technical.
  const po = await as(pim);
  await po.goto(grillingTab);
  await po.getByRole('button', { name: 'Start Grilling' }).click();
  await expect(po.getByRole('heading', { name: /^Current Grilling: Running/ })).toBeVisible();

  // Her Inbox Item opens her own Grilling Conversation, with the round header.
  await openFromInbox(po, 'Business', 'PO');
  const pimsUrl = po.url();
  const business = roundIn(po, 'Business · PO');
  await expect(business).toHaveAttribute('aria-current', 'step');
  await expect(business).toContainText(/0 of \d+ answered/);
  await expect(roundIn(po, 'UX · Designer')).toContainText('Not reached yet');
  await expect(roundIn(po, 'Technical · Tech Lead')).toContainText('Not reached yet');
  await expect(po.getByText('Question 1 of', { exact: false })).toBeVisible();
  await po.screenshot(shot('round-header.png'));

  // Mint, the other PO, opens hers from the starter card of a new Conversation, and
  // answers question 1.
  const mintPage = await as(mint);
  await mintPage.goto('/conversations/new');
  await mintPage.getByRole('link', { name: /Answer the Business round of Grilling/ }).click();
  await expect(mintPage).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  expect(mintPage.url()).not.toBe(pimsUrl);
  await answer(mintPage, FULL(1));
  await expect(mintPage.getByText('Thanks, I recorded your answer to question 1.')).toBeVisible();

  // Pim is told, live and quietly, and question 1 shows collapsed with who answered it.
  const notice = po.getByRole('note').filter({ hasText: 'Mint answered question 1 meanwhile' });
  await expect(notice).toBeVisible();
  const answered = po.getByRole('region', { name: 'Answered by others' }).locator('details');
  await expect(answered).toHaveCount(1);
  await expect(answered.first()).toContainText('Answered by Mint');
  await expect(answered.first().getByText(FULL(1))).toBeHidden();
  await answered.first().locator('summary').click();
  await expect(answered.first().getByText(FULL(1))).toBeVisible();
  await expect(business).toContainText(/1 of \d+ answered/);
  await toTop(po);
  await po.screenshot(shot('answered-collapsed.png'));

  // A thin answer gets a follow-up; her next reply records both.
  await answer(po, 'Grow.');
  await expect(po.locator('.msg.ai .who').last()).toHaveText('Follow-up 1 of 2');
  await expect(po.locator('.msg.ai').last()).toContainText('can you say more about');
  await po.screenshot(shot('follow-up.png'));
  await answer(po, 'Grow monthly active payers to 1.5M by Q4.');
  await expect(po.getByText('Thanks, I recorded your answer to question 2.')).toBeVisible();

  // "Skip this question" sends the skip word.
  await po.getByRole('button', { name: 'Skip this question' }).click();
  await expect(po.locator('.msg.user .bubble').last()).toHaveText('skip');
  await expect(po.getByText('Skipped question 3.')).toBeVisible();

  // Pim answers the rest; Mint answers the one Pim skipped, which ends the round.
  const left = Number((await business.textContent())?.match(/of (\d+) answered/)?.[1] ?? 0);
  for (let n = 4; n <= left; n++) {
    await answer(po, FULL(n));
    await expect(po.getByText(`Thanks, I recorded your answer to question ${n}.`)).toBeVisible();
  }
  await mintPage.reload();
  await expect(mintPage.getByText('Question 3 of', { exact: false }).last()).toBeVisible();
  await answer(mintPage, FULL(3));
  await expect(mintPage.getByText(/the Business round is complete/).last()).toBeVisible();

  // The Designer's round opens next, in Pim's header too.
  await expect(
    po.getByRole('note').filter({ hasText: 'the Business round is complete' }),
  ).toBeVisible();
  await expect(roundIn(po, 'UX · Designer')).toHaveAttribute('aria-current', 'step');
  await expect(business).toContainText('Complete');

  // In Thai (Accept-Language), the server's texts and the header read in Thai.
  const thai = await browser.newContext({ baseURL, locale: 'th-TH' });
  await thai.addCookies([{ name: 'vorasaan-user', value: pim.id, url: baseURL ?? '' }]);
  const pimThai = await thai.newPage();
  await pimThai.goto(pimsUrl);
  await expect(pimThai.getByRole('list', { name: 'รอบของ Grilling' })).toBeVisible();
  await expect(pimThai.getByText('คำถามที่ 1 จาก', { exact: false }).first()).toBeVisible();
  await expect(pimThai.getByText('ขอบคุณครับ บันทึกคำตอบข้อ 2 แล้ว')).toBeVisible();
  await toTop(pimThai);
  await pimThai.screenshot(shot('thai.png'));
  await thai.close();

  // Fern, the Designer, answers the UX round in her Conversation (on a phone).
  const designer = await as(fern);
  await designer.setViewportSize({ width: 390, height: 844 });
  await openFromInbox(designer, 'UX', 'Designer');
  await expect(roundIn(designer, 'UX · Designer')).toHaveAttribute('aria-current', 'step');
  await expect(roundIn(designer, 'Business · PO')).toContainText('Complete');
  const scrollWidth = await designer.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await designer.screenshot(shot('phone.png'));
  const ux = Number(
    (await roundIn(designer, 'UX · Designer').textContent())?.match(/of (\d+) answered/)?.[1] ?? 0,
  );
  expect(ux).toBeGreaterThan(0);
  for (let n = 1; n <= ux; n++) {
    await answer(designer, FULL(n));
    await expect(
      designer.getByText(`Thanks, I recorded your answer to question ${n}.`),
    ).toBeVisible();
  }

  // Oak answers the technical round on the Grilling form, which still works.
  await answerRoundOnTheForm(await as(oak), 'Technical');

  // The Brief Proposal appears in Pim's Conversation as an Action Card; she approves it.
  await po.goto(pimsUrl);
  const card = po.getByRole('article', { name: /^Change the Project Brief of/ });
  await expect(card).toBeVisible();
  await expect(
    po.getByRole('note').filter({ hasText: 'I drafted a Brief Proposal' }),
  ).toBeVisible();
  await expect(card).toContainText('From Grilling');
  // The note above the card, and the card's head.
  await card.evaluate((el) => {
    const thread = el.closest('.chat-thread');
    if (!thread) return;
    const offset = el.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    thread.scrollTop += offset - 110;
  });
  await po.screenshot(shot('brief-card.png'));
  await card.getByRole('button', { name: 'Approve Brief change' }).click();
  await expect(card).toContainText(/Approved · Brief v\d+/);
  await po.goto(`/projects/${SEED.projectId}?tab=brief`);
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
