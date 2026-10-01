import * as p from '@clack/prompts';
import type { MeView } from '@vorasaan/shared';
import { ApiError, VorasaanApi } from '../api.ts';
import {
  clearStoredConfig,
  configPath,
  DEFAULT_API_URL,
  loadConfig,
  readStoredConfig,
  writeStoredConfig,
} from '../config.ts';

export type LoginOptions = { url?: string; token?: string };
type Env = Record<string, string | undefined>;

function cancelled<T>(value: T | symbol): value is symbol {
  return p.isCancel(value);
}

/**
 * Verifies an access token against the server and saves both.
 * Tokens are created in the web app under Access tokens.
 */
export async function runLogin(
  options: LoginOptions,
  env: Env = process.env,
  fetchImpl?: typeof fetch,
): Promise<MeView | undefined> {
  const stored = await readStoredConfig(env);
  let apiUrl = options.url;
  let token = options.token;

  if (!apiUrl || !token) p.intro('vorasaan login');
  if (!apiUrl) {
    const answer = await p.text({
      message: 'Vorasaan server URL',
      initialValue: stored.apiUrl ?? DEFAULT_API_URL,
    });
    if (cancelled(answer)) return;
    apiUrl = answer;
  }
  if (!token) {
    p.note(`Create one in the web app: ${apiUrl.replace(/:4000\b/, ':3000')} → Access tokens`);
    const answer = await p.password({ message: 'Paste your access token' });
    if (cancelled(answer)) return;
    token = answer.trim();
  }

  const api = new VorasaanApi({ baseUrl: apiUrl, credentials: { token }, fetch: fetchImpl });
  let me: MeView;
  try {
    me = await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(401, 'That token was not accepted. Check it, or create a new one.');
    }
    throw error;
  }
  // Keep other settings (e.g. "notify": false) across sign-ins.
  await writeStoredConfig({ ...stored, apiUrl, token }, env);
  console.log(`Signed in as ${me.name} (${me.email}). Saved to ${configPath(env)}`);
  return me;
}

export async function runLogout(env: Env = process.env) {
  await clearStoredConfig(env);
  console.log('Signed out. Revoke the token in the web app if you no longer need it.');
}

export async function runWhoami(env: Env = process.env, fetchImpl?: typeof fetch) {
  const config = await loadConfig(env);
  const me = await new VorasaanApi({
    baseUrl: config.apiUrl,
    credentials: config.credentials,
    fetch: fetchImpl,
  }).me();
  console.log(`${me.name} <${me.email}>${me.isAdmin ? ' (Admin)' : ''} on ${config.apiUrl}`);
  return me;
}
