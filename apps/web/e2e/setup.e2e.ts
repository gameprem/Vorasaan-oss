import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E } from './env';

// First-run setup from an empty database (ticket 0063): the wizard prefills the browser's
// time zone, stores the calendar and language, and the first Admin lands on a Getting
// started checklist that ticks itself. Every other spec shares the seeded database, so this
// one starts its own server and web app on a database of its own.

const { setup } = E2E;
const children: ChildProcess[] = [];

function start(command: string[], cwd: string, env: Record<string, string>) {
  const [bin = '', ...args] = command;
  const child = spawn(bin, args, {
    cwd: fileURLToPath(new URL(cwd, import.meta.url)),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
}

async function waitFor(url: string) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up within 60 seconds`);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  execFileSync('bun', [fileURLToPath(new URL('./fresh-db.ts', import.meta.url))], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: setup.databaseUrl },
  });
  start(['bun', 'src/main.ts'], '../../server/', {
    PORT: String(setup.apiPort),
    DATABASE_URL: setup.databaseUrl,
    VORASAAN_AI: 'fake',
    VORASAAN_WEB_URL: setup.webUrl,
    VORASAAN_SECRET_KEY: randomBytes(32).toString('base64'),
    VORASAAN_SETUP_TOKEN: E2E.setupToken,
    VORASAAN_ESCALATION_JOB: 'off',
    VORASAAN_CHAT_CARDS_JOB: 'off',
  });
  start(['bun', '--bun', 'next', 'start', '--port', String(setup.webPort)], '../', {
    VORASAAN_API_URL: setup.apiUrl,
    // Sign in with the real session cookie over http://localhost.
    VORASAAN_INSECURE_COOKIES: 'true',
    VORASAAN_DEV_AUTH: 'false',
  });
  await Promise.all([waitFor(`${setup.apiUrl}/health`), waitFor(`${setup.webUrl}/login`)]);
});

test.afterAll(() => {
  // The web app first, so it never asks a server that is already gone.
  for (const child of children.reverse()) child.kill();
});

test('setup from an empty database: calendar and language, then Getting started ticks itself', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: setup.webUrl,
    timezoneId: 'Asia/Bangkok',
    locale: 'en-US',
  });
  const page = await context.newPage();

  await page.goto(`/setup?token=${E2E.setupToken}`);
  await expect(page.getByRole('heading', { name: 'Set up Vorasaan' })).toBeVisible();
  await page.getByLabel('Organization name').fill('Acme Bank');
  await page.getByLabel('Your name').fill('Nok');
  await page.getByLabel('Email').fill('nok@acmebank.test');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Calendar & language: the browser's time zone, Monday to Friday 09:00-18:00.
  await expect(page.locator('[aria-current="step"]')).toHaveText('2. Calendar & language');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Bangkok');
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    await expect(page.getByRole('checkbox', { name: day })).toBeChecked();
  }
  await expect(page.getByRole('checkbox', { name: 'Sat' })).not.toBeChecked();
  await expect(page.getByLabel('Working hours start')).toHaveValue('09:00');
  await page.getByLabel('Working hours end').fill('17:30');
  await page.getByLabel('Language', { exact: true }).selectOption('th');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Anthropic API key').fill('sk-ant-e2e-not-a-real-key');
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // The first Admin's Inbox: the checklist, nothing done yet.
  await expect(page).toHaveURL(/\/inbox/);
  const checklist = page.getByRole('region', { name: 'Getting started' });
  await expect(checklist).toBeVisible();
  const firstItem = checklist.getByRole('listitem', { name: /^Create a Project and a Team/ });
  await expect(firstItem).toHaveAttribute('data-done', 'false');

  // Where it's done: create a Project, then a Team in it.
  await checklist.getByRole('link', { name: 'Create a Project and a Team' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByLabel('Name', { exact: true }).fill('Mobile Banking');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByLabel('New Team name in Mobile Banking').fill('Checkout');
  await page.getByRole('button', { name: 'Add Team' }).click();
  await expect(page.getByRole('link', { name: /Checkout/ })).toBeVisible();

  await page.goto('/inbox');
  await expect(firstItem).toHaveAttribute('data-done', 'true');
  await expect(
    checklist.getByRole('listitem', { name: /^Create a Feature and write its Spec/ }),
  ).toHaveAttribute('data-done', 'false');

  // What the wizard stored, as Settings shows it.
  await page.goto('/settings/response-windows');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Bangkok');
  await expect(page.getByLabel('Working hours end')).toHaveValue('17:30');
  await page.goto('/settings/organization');
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('th');

  await context.close();
});
