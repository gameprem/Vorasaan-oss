// The Web UI screenshots: Playwright signs in through /login, as a person would, and
// captures each screen. PNG screenshots are re-encoded to WebP by Chromium itself.

import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import type { Seeded } from './seed';
import { PEOPLE, type PersonKey } from './story';

export type WebShot = { name: string; bytes: number };

type Options = {
  webUrl: string;
  seeded: Seeded;
  password: string;
  outDir: string;
  chromiumPath: string;
};

const QUALITY = 0.75;

/** Re-encodes a PNG as WebP in the browser (no image tooling needed). */
async function toWebp(browser: Browser, png: Buffer, quality: number): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    const dataUrl = await page.evaluate(
      async ({ src, quality }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        return canvas.toDataURL('image/webp', quality);
      },
      { src: `data:image/png;base64,${png.toString('base64')}`, quality },
    );
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } finally {
    await page.close();
  }
}

export async function captureWeb(options: Options): Promise<WebShot[]> {
  const { webUrl, seeded, password, outDir } = options;
  const browser = await chromium.launch({ executablePath: options.chromiumPath });
  const shots: WebShot[] = [];
  const contexts: BrowserContext[] = [];

  const save = async (name: string, png: Buffer, quality = QUALITY) => {
    const webp = await toWebp(browser, png, quality);
    await Bun.write(`${outDir}/${name}.webp`, webp);
    shots.push({ name: `${name}.webp`, bytes: webp.length });
    console.log(`  ✓ ${name}.webp (${Math.round(webp.length / 1024)} KB)`);
  };

  /** A signed-in page: the real /login form, with the person's email and password. */
  const signIn = async (
    who: PersonKey,
    view: { width: number; height: number; scale: number; dark?: boolean; mobile?: boolean },
  ): Promise<Page> => {
    const context = await browser.newContext({
      baseURL: webUrl,
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: view.scale,
      colorScheme: view.dark ? 'dark' : 'light',
      isMobile: view.mobile ?? false,
      hasTouch: view.mobile ?? false,
      locale: 'en-US',
      timezoneId: 'Asia/Bangkok',
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(PEOPLE[who].email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    return page;
  };

  /** Waits for fonts and for the page to settle. */
  const settle = async (page: Page) => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  };

  /** Scrolls the chat so the person's last message is at the top of the thread. */
  const fromLastMessage = async (page: Page) => {
    await page.locator('.chat-thread').evaluate((thread) => {
      const mine = thread.querySelectorAll('.msg.user');
      const last = mine[mine.length - 1] as HTMLElement | undefined;
      if (!last) return;
      const offset = last.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += offset - 12;
    });
    await page.waitForTimeout(300);
  };

  /** Scrolls the chat so the first Action Card's top is `margin` px below the thread's top. */
  const toCard = async (page: Page, margin: number) => {
    await page.locator('.chat-thread').evaluate((thread, gap) => {
      const card = thread.querySelector('article');
      if (!card) return;
      const offset = card.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += offset - gap;
    }, margin);
    await page.waitForTimeout(300);
  };

  const desktop = { width: 1280, height: 800, scale: 1.5 };

  try {
    const { conversations } = seeded;

    // The hero: Beam's Blocker drafted in a Feature Conversation, the Spec beside it.
    for (const dark of [false, true]) {
      const page = await signIn('beam', { ...desktop, height: 1000, dark });
      await page.goto(`/conversations/${conversations.hero}`);
      await page.getByRole('article').first().waitFor();
      await settle(page);
      await toCard(page, 80);
      await save(dark ? 'conversation-dark' : 'conversation', await page.screenshot(), 0.7);
    }

    // Pim's Spec Proposal card, with its diff, before approval.
    const pim = await signIn('pim', desktop);
    await pim.goto(`/conversations/${conversations.specChange}`);
    await pim.getByRole('article').first().waitFor();
    await settle(pim);
    await fromLastMessage(pim);
    await save('spec-proposal', await pim.screenshot());

    // Grilling in chat: the round header, a follow-up, a question answered by Mint.
    await pim.setViewportSize({ width: desktop.width, height: 900 });
    await pim.goto(`/conversations/${conversations.grilling}`);
    await pim.getByRole('list', { name: 'Grilling rounds' }).waitFor();
    await pim.getByRole('button', { name: 'Close the Project Brief panel' }).click();
    await settle(pim);
    await pim.locator('.chat-thread').evaluate((thread) => {
      thread.scrollTop = 0;
    });
    await save('grilling', await pim.screenshot());

    // The Inbox, tall enough for all its sections.
    await pim.goto('/inbox');
    await settle(pim);
    const tall = await pim.evaluate(() =>
      Math.max(...[...document.querySelectorAll('main, main *')].map((el) => el.scrollHeight)),
    );
    await pim.setViewportSize({
      width: desktop.width,
      height: Math.min(1500, Math.max(800, tall)),
    });
    await settle(pim);
    await save('inbox', await pim.screenshot());

    // Settings → AI models, opened from the app: a modal over the Inbox.
    await pim.setViewportSize({ width: desktop.width, height: desktop.height });
    await pim.getByRole('link', { name: 'Settings', exact: true }).click();
    const dialog = pim.getByRole('dialog', { name: 'Settings' });
    await dialog.waitFor();
    await dialog.getByRole('link', { name: 'AI models' }).click();
    await dialog.getByText('Fast', { exact: true }).first().waitFor();
    await settle(pim);
    // The Approved Models and the model per AI task, rather than the provider's URL.
    await dialog.getByRole('heading', { name: 'Approved Models' }).evaluate((h) => {
      h.scrollIntoView({ block: 'start' });
    });
    await pim.waitForTimeout(300);
    await save('settings-ai-models', await pim.screenshot());

    // A phone: the hero Conversation at 390 px.
    const phone = await signIn('beam', { width: 390, height: 844, scale: 2, mobile: true });
    await phone.goto(`/conversations/${conversations.hero}`);
    await phone.getByRole('article').first().waitFor();
    await settle(phone);
    await toCard(phone, 16);
    await save('phone', await phone.screenshot());
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
  return shots;
}
