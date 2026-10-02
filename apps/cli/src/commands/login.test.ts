import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../api.ts';
import { configPath, loadConfig, readStoredConfig } from '../config.ts';
import { runLogin, runLogout, runWhoami } from './login.ts';

const GOOD = 'vsp_good-token';

describe('vorasaan login / whoami / logout', () => {
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/me') return new Response(null, { status: 404 });
        if (req.headers.get('authorization') !== `Bearer ${GOOD}`) {
          return Response.json(
            { statusCode: 401, message: 'Sign in to continue' },
            { status: 401 },
          );
        }
        return Response.json({ id: 'u1', name: 'Beam', email: 'beam@acme.test', isAdmin: false });
      },
    });
  });

  afterAll(() => server.stop());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vorasaan-cli-'));
    env = { XDG_CONFIG_HOME: dir };
    return async () => rm(dir, { recursive: true, force: true });
  });

  test('saves the URL and a verified token with 0600 permissions', async () => {
    const me = await runLogin({ url: server.url.origin, token: GOOD }, env);
    expect(me?.name).toBe('Beam');
    expect(await readStoredConfig(env)).toEqual({ apiUrl: server.url.origin, token: GOOD });
    expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);

    const config = await loadConfig(env);
    expect(config).toEqual({
      apiUrl: server.url.origin,
      credentials: { token: GOOD },
      notify: true,
    });
    expect((await runWhoami(env)).email).toBe('beam@acme.test');
  });

  test('rejects a bad token and saves nothing', async () => {
    const error = await runLogin({ url: server.url.origin, token: 'vsp_bad' }, env).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('not accepted');
    expect(await readStoredConfig(env)).toEqual({});
  });

  test('env vars override the saved config; logout forgets the token', async () => {
    await runLogin({ url: server.url.origin, token: GOOD }, env);
    const overridden = await loadConfig({
      ...env,
      VORASAAN_TOKEN: 'vsp_env',
      VORASAAN_API_URL: 'http://x',
    });
    expect(overridden).toEqual({
      apiUrl: 'http://x',
      credentials: { token: 'vsp_env' },
      notify: true,
    });

    await runLogout(env);
    await expect(loadConfig(env)).rejects.toThrow('vorasaan login');
  });
});
