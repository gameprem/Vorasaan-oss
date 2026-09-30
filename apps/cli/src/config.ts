export type CliConfig = { apiUrl: string; userId: string };

export class ConfigError extends Error {}

/** Env-based config for the tracer bullet. `vorasaan login` (PAT) replaces VORASAAN_USER in the MVP. */
export function loadConfig(env: Record<string, string | undefined> = process.env): CliConfig {
  const userId = env.VORASAAN_USER;
  if (!userId) {
    throw new ConfigError(
      'VORASAAN_USER is not set. Export your user id (printed by `bun run db:seed`), e.g.\n' +
        '  export VORASAAN_USER=00000000-0000-4000-8000-000000000102',
    );
  }
  return { apiUrl: env.VORASAAN_API_URL ?? 'http://localhost:4000', userId };
}
