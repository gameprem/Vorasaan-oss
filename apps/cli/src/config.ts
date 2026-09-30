import { chmod, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_API_URL = 'http://localhost:4000';

/** Who the CLI acts as: an access token (normal), or a dev user id (VORASAAN_DEV_AUTH servers). */
export type Credentials = { token: string } | { devUserId: string };
export type CliConfig = { apiUrl: string; credentials: Credentials };

type Env = Record<string, string | undefined>;
type StoredConfig = { apiUrl?: string; token?: string };

export class ConfigError extends Error {}

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'vorasaan', 'config.json');
}

export async function readStoredConfig(env: Env = process.env): Promise<StoredConfig> {
  const file = Bun.file(configPath(env));
  if (!(await file.exists())) return {};
  try {
    return (await file.json()) as StoredConfig;
  } catch {
    throw new ConfigError(`${configPath(env)} is not valid JSON. Run \`vorasaan login\` again.`);
  }
}

/** Saves the server URL and token, readable only by the current user (0600). */
export async function writeStoredConfig(config: StoredConfig, env: Env = process.env) {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  await chmod(path, 0o600);
}

export async function clearStoredConfig(env: Env = process.env) {
  await rm(configPath(env), { force: true });
}

/** Env vars win over the saved config: VORASAAN_API_URL, VORASAAN_TOKEN, VORASAAN_USER (dev). */
export async function loadConfig(env: Env = process.env): Promise<CliConfig> {
  const stored = await readStoredConfig(env);
  const apiUrl = env.VORASAAN_API_URL || stored.apiUrl || DEFAULT_API_URL;
  const token = env.VORASAAN_TOKEN || stored.token;
  if (token) return { apiUrl, credentials: { token } };
  if (env.VORASAAN_USER) return { apiUrl, credentials: { devUserId: env.VORASAAN_USER } };
  throw new ConfigError('You are not signed in. Run `vorasaan login` first.');
}
