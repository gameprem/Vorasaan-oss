import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E } from './env';

/** Resets the end-to-end database before the run (after Playwright has started the servers). */
export default function globalSetup() {
  execFileSync('bun', [fileURLToPath(new URL('./reset-db.ts', import.meta.url))], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: E2E.databaseUrl },
  });
}
