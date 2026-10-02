// `bun run screenshots`: the README's screenshots, from the real running app.
//
// 1. Creates a fresh database (its name must end in _screens) and migrates it.
// 2. Starts a scripted OpenAI-compatible model (model.ts), the API on :4099 and a
//    production build of the web app on :3099. Neither runs with VORASAAN_DEV_AUTH.
// 3. Writes a realistic story through the API (seed.ts, story.ts).
// 4. Signs in through /login and captures the Web UI with Playwright, then runs the CLI
//    in a pseudo-terminal and renders it as SVG.
// 5. Stops what it started, by PID, and drops the database.
//
// Needs PostgreSQL with pgvector (docker compose up -d db) and a Chromium; set
// SCREENS_CHROMIUM to its path when Playwright's own isn't installed.
//
// Env: SCREENS_DATABASE_URL (default postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_screens),
//      SCREENS_API_PORT (4099), SCREENS_WEB_PORT (3099), SCREENS_MODEL_PORT (4098),
//      SCREENS_SKIP_BUILD=1 to reuse the last `next build`.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SEED_PASSWORD } from '@vorasaan/db/seed';
import { SQL, type Subprocess } from 'bun';
import { ageStory } from './age';
import { captureCli } from './capture-cli';
import { captureWeb } from './capture-web';
import { startScriptedModel } from './model';
import { accessToken, apiClient, seedStory } from './seed';

const root = resolve(import.meta.dir, '../../../..');
const webDir = join(root, 'apps/web');
const outDir = join(root, 'docs/images');

const databaseUrl =
  process.env.SCREENS_DATABASE_URL ??
  'postgresql://vorasaan:vorasaan@localhost:5432/vorasaan_screens';
const dbName = new URL(databaseUrl).pathname.slice(1);
if (!/^[a-z0-9_]+_screens$/.test(dbName)) {
  console.error(`Refusing to use "${dbName}": the screenshots database name must end in _screens.`);
  process.exit(1);
}
const apiPort = Number(process.env.SCREENS_API_PORT ?? 4099);
const webPort = Number(process.env.SCREENS_WEB_PORT ?? 3099);
const modelPort = Number(process.env.SCREENS_MODEL_PORT ?? 4098);
const apiUrl = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;
const chromiumPath =
  process.env.SCREENS_CHROMIUM ??
  ((await Bun.file('/opt/pw-browsers/chromium').exists()) ? '/opt/pw-browsers/chromium' : '');

const started: Subprocess[] = [];
const step = (text: string) => console.log(`\n▸ ${text}`);

/** Only what a child needs: no dev auth, no provider keys, no model overrides. */
function baseEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'];
  const env: Record<string, string> = {};
  for (const key of keep) if (process.env[key]) env[key] = process.env[key] as string;
  return { ...env, ...extra };
}

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}):\n${out}\n${err}`);
}

function start(name: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'ignore', stderr: 'pipe' });
  started.push(proc);
  let stderr = '';
  (async () => {
    for await (const chunk of proc.stderr)
      stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000);
  })();
  proc.exited.then((code) => {
    if (code && !stopping) console.error(`  ✖ ${name} exited (${code}):\n${stderr}`);
  });
  console.log(`  ${name}: pid ${proc.pid}`);
  return proc;
}

async function waitFor(url: string, name: string, seconds = 90) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`${name} did not answer at ${url}`);
}

/** The PIDs of a process's descendants, from /proc (Linux), so none outlives the run. */
async function descendants(pid: number): Promise<number[]> {
  try {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    const nested = await Promise.all(children.map(descendants));
    return [...children, ...nested.flat()];
  } catch {
    return [];
  }
}

let stopping = false;
async function stopAll() {
  stopping = true;
  for (const proc of started.reverse()) {
    const pids = [...(await descendants(proc.pid)), proc.pid];
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await Promise.race([proc.exited, Bun.sleep(5_000)]);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone, as it should be.
      }
    }
  }
}

const admin = new URL(databaseUrl);
admin.pathname = '/postgres';
const sql = new SQL(admin.toString());
const nextEnvPath = join(webDir, 'next-env.d.ts');
const nextEnv = await readFile(nextEnvPath, 'utf8');
const filesDir = await mkdtemp(join(tmpdir(), 'vorasaan-screens-'));
const model = startScriptedModel(modelPort);
let failed = false;

try {
  step(`Database ${dbName}`);
  await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE "${dbName}"`);
  await run(['bun', '--bun', 'prisma', 'migrate', 'deploy'], join(root, 'packages/db'), {
    ...baseEnv({ DATABASE_URL: databaseUrl }),
  });
  console.log('  migrated');

  if (process.env.SCREENS_SKIP_BUILD !== '1') {
    step('Web production build (next build)');
    await run(['bun', '--bun', 'next', 'build'], webDir, baseEnv({ NEXT_TELEMETRY_DISABLED: '1' }));
  }

  step('Starting the API, the web app and the scripted model');
  console.log(`  model: ${model.url}`);
  start(
    'api',
    ['bun', 'src/main.ts'],
    join(root, 'apps/server'),
    baseEnv({
      PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      VORASAAN_SECRET_KEY: randomBytes(32).toString('base64'),
      FILE_STORAGE_DRIVER: 'local',
      FILE_STORAGE_LOCAL_DIR: filesDir,
    }),
  );
  start(
    'web',
    ['bun', '--bun', 'next', 'start', '--port', String(webPort)],
    webDir,
    baseEnv({
      VORASAAN_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
    }),
  );
  await waitFor(`${apiUrl}/health`, 'The API');
  await waitFor(`${webUrl}/login`, 'The web app');

  step('Writing the story through the API');
  const api = apiClient(apiUrl);
  const seeded = await seedStory(api, model, SEED_PASSWORD);
  const screensDb = new SQL(databaseUrl);
  await ageStory(screensDb);
  await screensDb.close();
  console.log('  done');

  step('Web UI');
  const web = await captureWeb({ webUrl, seeded, password: SEED_PASSWORD, outDir, chromiumPath });

  step('CLI');
  const cli = await captureCli({
    root,
    apiUrl,
    outDir,
    model,
    projectId: seeded.projectId,
    token: (who) => accessToken(api, seeded.tokens[who], 'Laptop CLI'),
  });

  step('Images');
  for (const { name, bytes } of [...web, ...cli]) {
    console.log(`  ${name.padEnd(28)} ${(bytes / 1024).toFixed(0).padStart(4)} KB`);
  }
  const total = [...web, ...cli].reduce((sum, s) => sum + s.bytes, 0);
  console.log(`  ${'total'.padEnd(28)} ${(total / 1024).toFixed(0).padStart(4)} KB`);
} catch (error) {
  failed = true;
  console.error(`\n✖ ${(error as Error).stack ?? error}`);
} finally {
  step('Cleaning up');
  await stopAll();
  model.stop();
  await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((error) => {
    console.error(`  could not drop ${dbName}: ${(error as Error).message}`);
  });
  await sql.close();
  await rm(filesDir, { recursive: true, force: true });
  // next build rewrites next-env.d.ts; keep the committed one.
  await writeFile(nextEnvPath, nextEnv);
  console.log('  stopped, dropped and restored');
}
process.exit(failed ? 1 : 0);
