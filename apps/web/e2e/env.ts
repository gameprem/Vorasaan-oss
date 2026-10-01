// Where the end-to-end run lives. The defaults stay off the dev ports (3000, 4000) and the
// dev database, so a local dev stack can keep running alongside.
const apiPort = Number(process.env.E2E_API_PORT ?? 4010);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3010);

export const E2E = {
  apiPort,
  webPort,
  apiUrl: `http://localhost:${apiPort}`,
  webUrl: `http://localhost:${webPort}`,
  /** Truncated and re-seeded before every run; its name must end in _e2e. */
  databaseUrl:
    process.env.E2E_DATABASE_URL ?? 'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_e2e',
};
