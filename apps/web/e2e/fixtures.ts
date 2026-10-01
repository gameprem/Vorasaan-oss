import { test as base, type Page } from '@playwright/test';
import { SEED } from '@vorasaan/db/seed';

export { expect } from '@playwright/test';
export { SEED };

type SeedUser = { id: string; name: string };

/** Pim and Mint (PO), Beam (Backend), Fern (Designer) and Oak (Tech Lead). */
export const { pim, mint, beam, fern, oak } = SEED.users;

export const test = base.extend<{
  /** A page in its own browser context, signed in as `user` through the dev identity cookie. */
  as: (user: SeedUser) => Promise<Page>;
}>({
  as: async ({ browser, baseURL }, use) => {
    if (!baseURL) throw new Error('baseURL is not set');
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await use(async (user) => {
      const context = await browser.newContext({ baseURL });
      await context.addCookies([{ name: 'vorasaan-user', value: user.id, url: baseURL }]);
      contexts.push(context);
      return context.newPage();
    });
    for (const context of contexts) await context.close();
  },
});

/** A title no other run or test shares, so a locator never matches leftovers. */
export const unique = (title: string) => `${title} (${Date.now().toString(36)})`;
