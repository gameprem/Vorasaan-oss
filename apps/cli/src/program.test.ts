import { describe, expect, test } from 'bun:test';
import type { InitOptions } from './commands/init.ts';
import type { RaiseOptions } from './commands/raise-options.ts';
import type { ScanOptions } from './commands/scan.ts';
import { ConfigError } from './config.ts';
import { buildProgram } from './program.ts';

const emptyConfigDir = `${import.meta.dir}/.test-config-${process.pid}`;
const env = {
  VORASAAN_USER: 'user-1',
  VORASAAN_API_URL: 'http://api.test',
  XDG_CONFIG_HOME: emptyConfigDir,
};

let scanned: ScanOptions | undefined;
let initialized: InitOptions | undefined;
let tuiOpened = false;

async function run(args: string[], runEnv: Record<string, string | undefined> = env) {
  let received: RaiseOptions | undefined;
  scanned = undefined;
  initialized = undefined;
  tuiOpened = false;
  const program = buildProgram(
    {
      raise: async (_api, options) => {
        received = options;
      },
      login: async () => {},
      logout: async () => {},
      whoami: async () => {},
      scan: async (options) => {
        scanned = options;
      },
      init: async (options) => {
        initialized = options;
      },
      tui: async () => {
        tuiOpened = true;
      },
    },
    runEnv,
  ).exitOverride();
  await program.parseAsync(['bun', 'vorasaan', ...args]);
  return received;
}

describe('vorasaan raise argument parsing', () => {
  test('passes flags through to the action', async () => {
    expect(
      await run([
        'raise',
        '--feature',
        'f-1',
        '-k',
        'blocker',
        '-t',
        'Slow API',
        '-d',
        'Takes 8s',
        '-r',
        'po',
        '--yes',
      ]),
    ).toEqual({
      featureId: 'f-1',
      kind: 'BLOCKER',
      title: 'Slow API',
      description: 'Takes 8s',
      deciderRole: 'PO',
      withChoices: true,
      yes: true,
    });
  });

  test('--no-choices', async () => {
    expect((await run(['raise', '-k', 'question', '--no-choices']))?.withChoices).toBe(false);
  });

  test('fails with a readable error when not signed in', async () => {
    await expect(run(['raise'], { XDG_CONFIG_HOME: emptyConfigDir })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('vorasaan scan argument parsing', () => {
  const project = '00000000-0000-4000-8000-000000000201';

  test('asks by default: neither --dry-run nor --yes is implied', async () => {
    await run(['scan', '--project', project]);
    expect(scanned).toEqual({ projectId: project, dir: process.cwd(), dryRun: false, yes: false });
  });

  test('--dry-run, --yes and --dir', async () => {
    await run(['scan', '-p', project, '--dir', '/tmp/repo', '--dry-run', '-y']);
    expect(scanned).toEqual({ projectId: project, dir: '/tmp/repo', dryRun: true, yes: true });
  });

  test('needs a Project id', async () => {
    await expect(run(['scan', '--project', 'not-an-id'])).rejects.toThrow('--project');
  });
});

describe('vorasaan (no subcommand) and vorasaan init', () => {
  const project = '00000000-0000-4000-8000-000000000201';

  test('no subcommand opens the TUI; subcommands do not', async () => {
    await run([]);
    expect(tuiOpened).toBe(true);
    await run(['scan', '--project', project, '--dry-run']);
    expect(tuiOpened).toBe(false);
  });

  test('the TUI needs a sign-in', async () => {
    await expect(run([], { XDG_CONFIG_HOME: emptyConfigDir })).rejects.toBeInstanceOf(ConfigError);
  });

  test('raise --diff and --file (repeatable) add repository context', async () => {
    const options = await run(['raise', '--diff', '--file', 'a.ts', '--file', 'src/b.ts']);
    expect(options?.diff).toBe(true);
    expect(options?.files).toEqual(['a.ts', 'src/b.ts']);
  });

  test('init passes its flags; nothing is implied', async () => {
    await run(['init']);
    expect(initialized).toEqual({ dir: process.cwd(), scan: false, dryRun: false, yes: false });
    await run([
      'init',
      '-p',
      project,
      '--url',
      'http://vorasaan.test',
      '--scan',
      '--dry-run',
      '-y',
    ]);
    expect(initialized).toEqual({
      dir: process.cwd(),
      projectId: project,
      apiUrl: 'http://vorasaan.test',
      scan: true,
      dryRun: true,
      yes: true,
    });
  });

  test('init rejects a bad Project id and --dry-run without --scan', async () => {
    await expect(run(['init', '-p', 'nope'])).rejects.toThrow('--project');
    await expect(run(['init', '--dry-run'])).rejects.toThrow('--scan');
  });
});
