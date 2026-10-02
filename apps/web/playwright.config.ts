import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/env';

// End-to-end tests of the main web flows, against the real server with canned AI output
// (VORASAAN_AI=fake, which also fakes embeddings) and the dev identity cookie.
//
//   1. Migrate the database:  DATABASE_URL=<E2E_DATABASE_URL> bun run db:deploy  (packages/db)
//   2. Build the web app:     bun --bun next build
//   3. Run:                   bun run e2e
//
// Playwright starts the server and `next start`, then global-setup re-seeds the database.
// The specs are *.e2e.ts so `bun test` never picks them up.

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  // The flows share one seeded Organization and Feature, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E.webUrl,
    // Fail a missing button or link in seconds, with its name, not at the test timeout.
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A Chromium already on the machine, instead of the one `playwright install` downloads.
        launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH || undefined },
      },
    },
  ],
  webServer: [
    {
      name: 'server',
      command: 'bun src/main.ts',
      cwd: '../server',
      url: `${E2E.apiUrl}/health`,
      env: {
        PORT: String(E2E.apiPort),
        DATABASE_URL: E2E.databaseUrl,
        VORASAAN_AI: 'fake',
        VORASAAN_DEV_AUTH: 'true',
        VORASAAN_SECRET_KEY: randomBytes(32).toString('base64'),
        // Chat app replies go to the fake LINE API in chat-apps.e2e.ts, never to LINE.
        VORASAAN_LINE_API_URL: E2E.fakeChatUrl,
      },
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: `bun --bun next start --port ${E2E.webPort}`,
      url: `${E2E.webUrl}/login`,
      env: {
        VORASAAN_API_URL: E2E.apiUrl,
        VORASAAN_DEV_AUTH: 'true',
      },
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
