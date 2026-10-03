// Where the end-to-end run lives. The defaults stay off the dev ports (3000, 4000) and the
// dev database, so a local dev stack can keep running alongside.
const apiPort = Number(process.env.E2E_API_PORT ?? 4010);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3010);
/** A fake LINE API the server sends its chat replies to (chat-apps.e2e.ts listens on it). */
const fakeChatPort = Number(process.env.E2E_FAKE_CHAT_PORT ?? 4019);

/** The first-run setup spec's own server and web app, on an empty database (ticket 0063). */
const setupApiPort = Number(process.env.E2E_SETUP_API_PORT ?? apiPort + 5);
const setupWebPort = Number(process.env.E2E_SETUP_WEB_PORT ?? webPort + 5);
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_e2e';

/** Next to the e2e database, on the same Postgres: vorasaan_e2e → vorasaan_setup_e2e. */
function setupDatabaseUrl(): string {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/_e2e$/, '')}_setup_e2e`;
  return url.toString();
}

export const E2E = {
  apiPort,
  webPort,
  apiUrl: `http://localhost:${apiPort}`,
  webUrl: `http://localhost:${webPort}`,
  fakeChatPort,
  fakeChatUrl: `http://127.0.0.1:${fakeChatPort}`,
  /** The server's Setup Token (ticket 0062), for a run that starts on an empty database. */
  setupToken: process.env.E2E_SETUP_TOKEN ?? 'e2e-setup-token-not-a-secret',
  /** Truncated and re-seeded before every run; its name must end in _e2e. */
  databaseUrl,
  setup: {
    apiPort: setupApiPort,
    webPort: setupWebPort,
    apiUrl: `http://localhost:${setupApiPort}`,
    webUrl: `http://localhost:${setupWebPort}`,
    /** Created, migrated and emptied by setup.e2e.ts before its server starts. */
    databaseUrl: process.env.E2E_SETUP_DATABASE_URL ?? setupDatabaseUrl(),
  },
};
